import { t, useProps, type StripBrands } from "../src";

const schema = t.map(t.string(), t.set(t.number()));
const value: StripBrands<typeof schema> = new Map([["a", new Set([1])]]);
void value;
class Collections {
  props = useProps({ entries: schema, ids: t.set(t.number()).optional(() => new Set<number>()) });
}
declare const component: Collections;
component.props.entries.get("a")?.add(1);
component.props.ids.add(2);
// @ts-expect-error collection schemas are validators, not collection values
schema.set("a", new Set([1]));
// @ts-expect-error the map requires both schemas
t.map(t.string());
// @ts-expect-error constructor functions are not schemas
t.set(Number);
// @ts-expect-error map keys are strings
component.props.entries.get(1);
// @ts-expect-error nested set entries are numbers
component.props.entries.get("a")?.add("bad");
