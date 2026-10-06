import { signal, untrack } from "@odoo/owl-core";
import { Component } from "./component";
import { onError } from "./lifecycle_hooks";
import { props } from "./props";
import { xml } from "./template_set";
import { types as t } from "./types";

export class ErrorBoundary extends Component {
  static template = xml`
    <t t-if="this.props.error()">
      <t t-call-slot="fallback"/>
    </t>
    <t t-else="">
      <t t-call-slot="default"/>
    </t>
  `;

  props = props({ error: t.signal().optional(() => signal<any>(null)) });

  setup() {
    onError((e) =>
      untrack(() => {
        // an error while the fallback shows is the fallback's: caught here, it
        // would show that fallback again, failing again
        if (this.props.error()) {
          throw e;
        }
        this.props.error.set(e);
      })
    );
  }
}
