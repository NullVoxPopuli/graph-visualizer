/**
 * Minimal Glint signature for `@html-next/vertical-collection`. The
 * package ships JS only; this declaration teaches the type-checker
 * the args we use (`@items`, `@key`, `@estimateHeight`, `@bufferSize`)
 * and the `default` block yield shape (`[item, index]`) so the panels
 * can invoke it inside `.gts` templates.
 */
declare module "@html-next/vertical-collection" {
  import type Component from "@glimmer/component";

  export class VerticalCollection<T = unknown> extends Component<{
    Args: {
      items: readonly T[];
      key?: string;
      estimateHeight: number;
      bufferSize?: number;
      staticHeight?: boolean;
      containerSelector?: string;
      renderAll?: boolean;
      renderFromLast?: boolean;
      idForFirstItem?: string;
      shouldRecycle?: boolean;
    };
    Blocks: {
      default: [item: T, index: number];
    };
  }> {}
}
