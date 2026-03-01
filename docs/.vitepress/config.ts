import { defineConfig } from "vitepress";

export default defineConfig({
	base: "/bun-smtp/",
	title: "bun-smtp",
	description: "Fast SMTP/LMTP server library for Bun",
	head: [["link", { rel: "icon", href: "/bun-smtp/favicon.ico" }]],
	themeConfig: {
		nav: [
			{ text: "Guide", link: "/guide/getting-started" },
			{ text: "Reference", link: "/reference/configuration" },
			{
				text: "GitHub",
				link: "https://github.com/puiusabin/bun-smtp",
			},
		],
		sidebar: [
			{
				text: "Guide",
				items: [
					{ text: "Getting Started", link: "/guide/getting-started" },
					{
						text: "Migrating from smtp-server",
						link: "/guide/migrating-from-smtp-server",
					},
					{ text: "Authentication", link: "/guide/authentication" },
					{ text: "TLS & STARTTLS", link: "/guide/tls" },
				],
			},
			{
				text: "Reference",
				items: [
					{ text: "Configuration", link: "/reference/configuration" },
					{ text: "Callbacks", link: "/reference/callbacks" },
					{ text: "Session & Envelope", link: "/reference/session" },
					{ text: "Events", link: "/reference/events" },
				],
			},
		],
		socialLinks: [
			{ icon: "github", link: "https://github.com/puiusabin/bun-smtp" },
		],
		footer: {
			message: "Released under the MIT License.",
		},
	},
});
