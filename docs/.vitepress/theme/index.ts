import type { Theme } from "vitepress";
import DefaultTheme from "vitepress/theme";
import { h } from "vue";
import HeroCode from "./HeroCode.vue";

export default {
	extends: DefaultTheme,
	Layout: () => {
		return h(DefaultTheme.Layout, null, {
			"home-hero-image": () => h(HeroCode),
		});
	},
} satisfies Theme;
