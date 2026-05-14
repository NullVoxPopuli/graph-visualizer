import { tracked } from "@glimmer/tracking";
import Service from "@ember/service";

import type { LoadedGraph } from "#lib/types";

export default class GraphService extends Service {
  @tracked current: LoadedGraph | null = null;

  get isLoaded(): boolean {
    return this.current !== null;
  }

  get nodeCount(): number {
    return this.current?.ids.length ?? 0;
  }

  get edgeCount(): number {
    return (this.current?.edgesFlat.length ?? 0) / 2;
  }

  load(g: LoadedGraph): void {
    this.current = g;
  }

  clear(): void {
    this.current = null;
  }
}
