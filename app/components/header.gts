import { LinkTo } from "@ember/routing";

import IconGithubLogo from "~icons/simple-icons/github";

export const Header = <template>
  <header class="app-header">
    <LinkTo @route="analyze" class="app-header__analyze">select new analysis</LinkTo>
    <span class="app-header__brand">graph visualizer</span>
    <nav class="app-header__nav">
      <a
        href="https://github.com/NullVoxPopuli/graph-visualizer"
        target="_blank"
        rel="noopener"
        class="app-header__github"
        aria-label="view source on GitHub"
        title="view source on GitHub"
      >
        <IconGithubLogo class="app-header__github-icon" aria-hidden="true" />
      </a>
      <LinkTo @route="docs">docs</LinkTo>
    </nav>
  </header>
</template>;
