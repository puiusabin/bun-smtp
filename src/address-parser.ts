/**
 * Parses SMTP MAIL FROM and RCPT TO address strings.
 *
 * Input examples:
 *   "MAIL FROM:<user@example.com> BODY=8BITMIME SIZE=12345"
 *   "RCPT TO:<> NOTIFY=SUCCESS,FAILURE"
 *
 * Returns { address, args } or false if parsing fails.
 */

import type { SMTPAddress, SMTPAddressArgs } from "./types.ts";

// Decodes xtext encoding: +HH hex sequences
function decodeXtext(value: string): string {
  return value.replace(/\+([0-9A-F]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

/**
 * @param name  Expected prefix ("MAIL FROM" or "RCPT TO"), case-insensitive
 * @param command  Full command string e.g. "MAIL FROM:<user@domain> SIZE=1234"
 * @returns parsed address object or false
 */
export function parseAddressCommand(name: string, command: string): SMTPAddress | false {
  const normalizedName = name.trim().toUpperCase();
  const colonIdx = command.indexOf(":");

  if (colonIdx === -1) return false;

  const prefix = command.slice(0, colonIdx).trim().toUpperCase();
  if (prefix !== normalizedName) return false;

  const rest = command.slice(colonIdx + 1).trim();
  const parts = rest.split(/\s+/);
  const rawAddress = parts.shift() ?? "";

  let address = "";
  let invalid = false;

  // Must be wrapped in angle brackets
  if (!/^<[^<>]*>$/.test(rawAddress)) {
    invalid = true;
  } else {
    address = rawAddress.slice(1, -1); // strip < >
  }

  // Parse ESMTP parameters
  let args: SMTPAddressArgs | false = false;
  for (const part of parts) {
    const eqIdx = part.indexOf("=");
    let key: string;
    let value: string | true;

    if (eqIdx === -1) {
      key = part.toUpperCase();
      value = true;
    } else {
      key = part.slice(0, eqIdx).toUpperCase();
      value = decodeXtext(part.slice(eqIdx + 1));
    }

    if (!key || key.trim() === "") continue;

    if (!args) args = {};
    (args as Record<string, string | true>)[key] = value;
  }

  if (invalid) return false;

  // Validate the address
  if (address !== "") {
    // Bounce address is allowed: empty string from "<>"
    const atIdx = address.lastIndexOf("@");
    if (atIdx <= 0 || atIdx === address.length - 1) {
      // No @ or @ is first/last character
      invalid = true;
    } else {
      const localPart = address.slice(0, atIdx);
      const domain = address.slice(atIdx + 1);

      // RFC 5321 §4.5.3.1.1: local part max 64 octets
      if (localPart.length > 64) {
        invalid = true;
      }

      // RFC 5321 §4.5.3.1.3: path limit 254 octets (local + @ + domain)
      if (!invalid && localPart.length + 1 + domain.length > 254) {
        invalid = true;
      }

      if (!invalid) {
        // Basic local-part validation: reject leading/trailing dots and ".."
        if (localPart.startsWith(".") || localPart.endsWith(".") || localPart.includes("..")) {
          invalid = true;
        }
      }

      if (!invalid) {
        // Check for IP literal domain [IPv4] or [IPv6:...]
        const isIPLiteral = domain.startsWith("[") && domain.endsWith("]");
        if (isIPLiteral) {
          const inner = domain.slice(1, -1);
          let validIP = false;

          if (inner.toUpperCase().startsWith("IPV6:")) {
            // Just a basic format check — Bun/Node net.isIPv6 available via import
            const ipv6 = inner.slice(5);
            validIP = isIPv6(ipv6);
          } else {
            validIP = isIPv4(inner);
          }

          if (!validIP) invalid = true;
        } else {
          // Regular domain: reject obvious invalid patterns
          if (
            domain.startsWith(".") ||
            domain.endsWith(".") ||
            domain.includes("..") ||
            domain.includes(".-") ||
            domain.includes("-.") ||
            !/^[a-zA-Z0-9\u0080-\uFFFF.-]+$/.test(domain)
          ) {
            invalid = true;
          }
        }
      }
    }
  }

  if (invalid) return false;

  return { address, args };
}

// ---- Minimal IP validators (avoid importing net) -------------------------

function isIPv4(s: string): boolean {
  const parts = s.split(".");
  if (parts.length !== 4) return false;
  return parts.every(p => {
    const n = Number(p);
    return /^\d+$/.test(p) && n >= 0 && n <= 255;
  });
}

function isIPv6(s: string): boolean {
  // Very permissive: just check for hex groups and colons
  return /^[0-9a-fA-F:]+$/.test(s) && s.includes(":");
}
