import type { Socket } from "bun";

// ---- TLS ----------------------------------------------------------------

export interface TLSOptions {
  key?: string | Buffer;
  cert?: string | Buffer;
  ca?: string | Buffer | Array<string | Buffer>;
  requestCert?: boolean;
  rejectUnauthorized?: boolean;
  honorCipherOrder?: boolean;
  minVersion?: string;
  maxVersion?: string;
  sessionIdContext?: string;
  /** SNI: map of hostname -> TLS options */
  sniOptions?: Record<string, TLSOptions> | Map<string, TLSOptions>;
}

// ---- Session / Envelope -------------------------------------------------

export interface DSNEnvelope {
  ret: "FULL" | "HDRS" | null;
  envid: string | null;
}

export interface DSNRcpt {
  notify?: string[];
  orcpt?: string;
}

export interface SMTPEnvelope {
  mailFrom: SMTPAddress | false;
  rcptTo: SMTPAddress[];
  bodyType: "7bit" | "8bitmime";
  smtpUtf8: boolean;
  requireTLS: boolean;
  dsn?: DSNEnvelope;
}

export interface SMTPAddressArgs {
  SIZE?: string;
  BODY?: string;
  SMTPUTF8?: true;
  REQUIRETLS?: true;
  RET?: string;
  ENVID?: string;
  NOTIFY?: string;
  ORCPT?: string;
  [key: string]: string | true | undefined;
}

export interface SMTPAddress {
  address: string;
  args: SMTPAddressArgs | false;
  dsn?: DSNRcpt;
}

export interface TLSCipherInfo {
  name: string;
  standardName?: string;
  version?: string;
}

export interface SMTPSession {
  id: string;
  secure: boolean;
  servername?: string;
  localAddress: string;
  localPort: number;
  remoteAddress: string;
  remotePort: number;
  clientHostname: string;
  openingCommand: string;
  hostNameAppearsAs: string;
  xClient: Map<string, string | false>;
  xForward: Map<string, string | false>;
  transmissionType: string;
  tlsOptions: TLSCipherInfo | false;
  user: unknown;
  transaction: number;
  envelope: SMTPEnvelope;
  error?: string;
  isWizard?: boolean;
}

// ---- Auth ---------------------------------------------------------------

export interface AuthObjectPlain {
  method: "PLAIN" | "LOGIN";
  username: string;
  password: string;
}

export interface AuthObjectCramMd5 {
  method: "CRAM-MD5";
  username: string;
  challenge: string;
  challengeResponse: string;
  validatePassword(password: string): boolean;
}

export interface AuthObjectXoauth2 {
  method: "XOAUTH2";
  username: string;
  accessToken: string;
}

export interface AuthObjectXclient {
  method: "XCLIENT";
  username: string;
  password: null;
}

export type AuthObject =
  | AuthObjectPlain
  | AuthObjectCramMd5
  | AuthObjectXoauth2
  | AuthObjectXclient;

export interface AuthResponse {
  user?: unknown;
  message?: string;
  responseCode?: number;
  /** XOAUTH2 challenge data */
  data?: Record<string, string>;
}

// ---- Server Callbacks ---------------------------------------------------

export type SMTPCallback<T = void> = (err: Error | null, result?: T) => void;

export interface SMTPError extends Error {
  responseCode?: number;
  code?: string;
  report?: boolean;
  meta?: Record<string, unknown>;
}

export type OnConnectCallback = (session: SMTPSession, callback: (err?: SMTPError | null) => void) => void;
export type OnSecureCallback = (socket: Socket<unknown>, session: SMTPSession, callback: (err?: SMTPError | null) => void) => void;
export type OnAuthCallback = (auth: AuthObject, session: SMTPSession, callback: (err: SMTPError | null, response?: AuthResponse) => void) => void;
export type OnMailFromCallback = (address: SMTPAddress, session: SMTPSession, callback: (err?: SMTPError | null) => void) => void;
export type OnRcptToCallback = (address: SMTPAddress, session: SMTPSession, callback: (err?: SMTPError | null) => void) => void;
export type OnDataCallback = (stream: DataStream, session: SMTPSession, callback: (err: SMTPError | null, message?: string | Array<string | SMTPError>) => void) => void;
export type OnCloseCallback = (session: SMTPSession) => void;

// A ReadableStream with extra metadata set after the stream closes
export interface DataStream extends ReadableStream<Uint8Array> {
  byteLength?: number;
  sizeExceeded?: boolean;
}

// ---- Constructor Options ------------------------------------------------

export interface SMTPServerOptions extends TLSOptions {
  // Connection
  secure?: boolean;
  needsUpgrade?: boolean;
  name?: string;
  banner?: string;
  lmtp?: boolean;

  // Auth
  authMethods?: string[];
  authOptional?: boolean;
  allowInsecureAuth?: boolean;
  authRequiredMessage?: string;

  // Capabilities
  disabledCommands?: string[];
  hideSTARTTLS?: boolean;
  hideSize?: boolean;
  hidePIPELINING?: boolean;
  hideDSN?: boolean;
  hideENHANCEDSTATUSCODES?: boolean;
  hideREQUIRETLS?: boolean;
  hide8BITMIME?: boolean;
  hideSMTPUTF8?: boolean;

  // Limits
  size?: number;
  maxClients?: number;
  maxAllowedUnauthenticatedCommands?: number | false;
  socketTimeout?: number;
  closeTimeout?: number;

  // Proxy / X-headers
  useXClient?: boolean;
  useXForward?: boolean;
  useProxy?: boolean | string[];

  // DNS
  disableReverseLookup?: boolean;
  resolver?: { reverse: (ip: string, callback: (err: Error | null, hostnames?: string[]) => void) => void };

  // HELO response format
  heloResponse?: string;

  // Callbacks (can be set as constructor options or overridden as methods)
  onConnect?: OnConnectCallback;
  onSecure?: OnSecureCallback;
  onAuth?: OnAuthCallback;
  onMailFrom?: OnMailFromCallback;
  onRcptTo?: OnRcptToCallback;
  onData?: OnDataCallback;
  onClose?: OnCloseCallback;
}

// ---- Server Event Map ---------------------------------------------------

export interface ConnectionInfo {
  id: string;
  localAddress: string;
  localPort: number;
  remoteAddress: string;
  remotePort: number;
  hostNameAppearsAs: string;
  clientHostname: string;
}

export type SMTPServerEventMap = {
  listening: [];
  close: [];
  error: [SMTPError];
  connect: [ConnectionInfo];
};

// ---- Internal Connection Context ----------------------------------------

export interface ConnectionContext {
  id: string;
  session: SMTPSession;
  server: ServerInstance;
  socket: Socket<ConnectionContext>;

  // Async processing queue
  processing: boolean;
  pendingChunks: Buffer[];

  // Parser
  parser: import("./smtp-parser.ts").SMTPParser;

  // Connection flags
  ready: boolean;
  secure: boolean;
  upgrading: boolean;
  closing: boolean;
  closed: boolean;
  canEmitConnection: boolean;

  // Multi-step AUTH handler
  nextHandler: ((line: string, done: () => void) => void) | null;

  // Counters
  unauthCmds: number;
  unknownCmds: number;
  transactionCounter: number;
  maxAllowedUnauthCmds: number;

  // Network info
  name: string;
  localAddress: string;
  localPort: number;
  remoteAddress: string;
  remotePort: number;
  clientHostname: string;
  openingCommand: string;
  hostNameAppearsAs: string;
  xClient: Map<string, string | false>;
  xForward: Map<string, string | false>;
  tlsOptions: TLSCipherInfo | false;

  // Timeout
  timeoutHandle: ReturnType<typeof setTimeout> | null;

  // DATA mode
  dataController: ReadableStreamDefaultController<Uint8Array> | null;
  dataStream: DataStream | null;
  dataBytes: number;
  dataMaxBytes: number;
}

// Minimal interface the connection code needs from SMTPServer
export interface ServerInstance {
  options: Required<Pick<SMTPServerOptions,
    | "secure" | "needsUpgrade" | "name" | "banner" | "lmtp"
    | "authMethods" | "authOptional" | "allowInsecureAuth" | "authRequiredMessage"
    | "disabledCommands" | "hideSTARTTLS" | "hideSize" | "hidePIPELINING"
    | "hideDSN" | "hideENHANCEDSTATUSCODES" | "hideREQUIRETLS" | "hide8BITMIME" | "hideSMTPUTF8"
    | "size" | "maxClients" | "socketTimeout" | "closeTimeout"
    | "useXClient" | "useXForward" | "disableReverseLookup"
    | "heloResponse"
  >> & SMTPServerOptions;
  connections: Set<ConnectionContext>;
  closing: boolean;
  onConnect: OnConnectCallback;
  onSecure: OnSecureCallback;
  onAuth: OnAuthCallback;
  onMailFrom: OnMailFromCallback;
  onRcptTo: OnRcptToCallback;
  onData: OnDataCallback;
  onClose: OnCloseCallback;
  emit<K extends keyof SMTPServerEventMap>(event: K, ...args: SMTPServerEventMap[K]): void;
  _notifyConnectionClosed(): void;
  tlsKey: string;
  tlsCert: string;
}
