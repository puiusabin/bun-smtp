<template>
	<div class="hero-code">
		<div class="hero-code-titlebar">
			<span class="hero-code-dot hero-code-dot-red" />
			<span class="hero-code-dot hero-code-dot-yellow" />
			<span class="hero-code-dot hero-code-dot-green" />
		</div>
		<pre class="hero-code-pre"><code><span class="tok-kw">import</span> { SMTPServer } <span class="tok-kw">from</span> <span class="tok-str">"bun-smtp"</span>;

<span class="tok-kw">const</span> server = <span class="tok-kw">new</span> <span class="tok-fn">SMTPServer</span>({
  authOptional: <span class="tok-const">true</span>,
  <span class="tok-fn">onData</span>(stream, session, cb) {
    <span class="tok-comment">// handle incoming mail</span>
    cb(<span class="tok-const">null</span>);
  },
});

<span class="tok-kw">await</span> server.<span class="tok-fn">listen</span>(<span class="tok-num">2525</span>);</code></pre>
	</div>
</template>

<style scoped>
.hero-code {
	width: 100%;
	max-width: 480px;
	border-radius: 12px;
	overflow: hidden;
	background-color: var(--vp-code-block-bg);
	border: 1px solid var(--vp-c-divider);
	box-shadow: var(--vp-shadow-3);
}

.hero-code-titlebar {
	display: flex;
	align-items: center;
	gap: 6px;
	padding: 10px 14px;
	border-bottom: 1px solid var(--vp-c-divider);
}

.hero-code-dot {
	width: 10px;
	height: 10px;
	border-radius: 50%;
}

.hero-code-dot-red {
	background-color: #ff5f56;
}

.hero-code-dot-yellow {
	background-color: #ffbd2e;
}

.hero-code-dot-green {
	background-color: #27c93f;
}

.hero-code-pre {
	margin: 0;
	padding: 20px;
	overflow-x: auto;
	font-family: var(--vp-font-family-mono);
	font-size: 13px;
	line-height: 1.7;
	color: var(--vp-c-text-1);
	text-align: left;
}

.tok-kw {
	color: var(--vp-c-brand-1);
}

.tok-str {
	color: var(--vp-c-green-1);
}

.tok-fn {
	color: var(--vp-c-purple-1);
}

.tok-const {
	color: var(--vp-c-yellow-1);
}

.tok-num {
	color: var(--vp-c-yellow-1);
}

.tok-comment {
	color: var(--vp-c-text-3);
	font-style: italic;
}
</style>
