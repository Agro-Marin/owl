// Odoo's template custom directives, for the template compile checks
// (compile_templates.cjs, compile_inherited_templates.mjs): a template using
// t-custom-* compiles only with them. Copied from the sources, keep in step:
// click from web/static/src/env.js, ref, model and portal from spreadsheet's
// o_spreadsheet.js.
module.exports = {
  click: (node, value, modifiers) => {
    const mods = ["synthetic", "capture"]
      .filter((m) => modifiers.includes(m))
      .map((m) => "." + m)
      .join("");
    const hasStop = modifiers.includes("stop");
    const hasPrevent = modifiers.includes("prevent");
    const handler = `(ev) => __globals__.click(ev, (${value}).bind(this), ${hasStop}, ${hasPrevent})`;
    node.setAttribute(`t-on-click${mods}`, handler);
    node.setAttribute(`t-on-auxclick${mods}`, handler);
  },
  ref: (node, value) => {
    const refName = `"` + value.replaceAll(/\{\{(.+?)\}\}/g, `" + $1 + "`) + `"`;
    node.setAttribute("t-ref", `__globals__.createRefSignal(this, ${refName})`);
  },
  model: (node, value, modifiers) => {
    node.setAttribute(
      ["t-model", ...modifiers].join("."),
      `__globals__.createModelSignal(() => ${value}, (nv) => {${value} = nv;})`
    );
  },
  portal: (node, value) => {
    if (node.nodeName.toLowerCase() !== "t") {
      throw new Error("t-custom-portal should be on a 't' element");
    }
    node.setAttribute("t-component", "__globals__.Portal");
    node.setAttribute("selector", value);
  },
};
