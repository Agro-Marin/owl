import type { ComponentNode } from "./component_node";

interface StaticComponentProperties {
  template: string;
  components?: { [componentName: string]: ComponentConstructor };
}

export interface ComponentConstructor extends StaticComponentProperties {
  new (node: ComponentNode): Component;
}

export class Component {
  static template: string = "";

  // A component's class with its statics, as `useProps(this.constructor.props)`
  // reads them: a subclass declares statics (props, defaults, ...) this class
  // cannot know of.
  declare ["constructor"]: ComponentConstructor & { props?: any; [key: string]: any };

  __owl__: ComponentNode;

  constructor(node: ComponentNode) {
    this.__owl__ = node;
  }

  setup() {}
}
