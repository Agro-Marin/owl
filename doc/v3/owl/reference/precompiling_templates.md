# Precompiling templates

Owl is designed to be used by the Odoo javascript framework. Since Odoo handles
its assets in its own non standard way, it was decided/assumed that Owl would
compile templates at runtime.

However, in some cases, it is not optimal, or even worse, not possible to do that.
For example, browser extensions do not allow javascript code to create a new
function (using the `new Function(...)` syntax).

Therefore, in these cases, it is required to compile templates ahead of time. It
is possible to do that in Owl, but the tooling is still rough. For now, the
process is the following:

1. write your templates in xml files (with a `t-name` directive to declare the name
   of the template)
2. Compile them in a `templates.js` file
3. get the `owl.runtime.es.js` file (an owl build without the compiler)
4. bundle `owl.runtime.es.js` and `template.js` with your assets (owl needs to
   be positioned before the templates)

Here is a more detailed explanation on how to compile xml files into a js file:

1. clone the owl repository locally
2. `npm install` to install all the required tooling
3. `npm run build` to build the `owl.runtime.es.js` file (in
   `packages/owl/dist/`)
4. `npm run compile_templates -- path/to/your/templates` (Node 26 runs the
   compiler's TypeScript sources: nothing to build for it) will scan your
   target folder, find all xml files, get all templates, compile them, and
   generate a `templates.js` file (`-o <path>` to name it).

The generated `templates.js` exports a single `templates` object, whose keys
are template names and whose values are precompiled template functions. It
can be passed directly to the `App` (or `mount`) `templates` config:

```js
import { mount } from "@odoo/owl";
import { templates } from "./templates.js";

mount(Root, document.body, { templates });
```

The same object shape is accepted by `app.addTemplate(name, fn)` and the
static `App.registerTemplate(name, fn)` helper, which registers a template
globally for every subsequently created `App`.

A page whose templates are mostly precompiled, but that may meet one that is
not, can load the compiler later: importing `@odoo/owl/compiler`
(`owl.compiler.es.js`, which Node's `require()` loads too) installs it into the
runtime, whichever way the two files are resolved. The
compiler registers itself under its build (version and hash), and a runtime
takes the compiler of its own build only, so two owl builds on one page each
find theirs. A runtime whose build's compiler is not loaded compiles nothing:
`TemplateSet.compiler` reads `null`, and compiling a template throws, naming
the runtime's build and those of the compilers loaded. Setting
`TemplateSet.compiler` by hand checks the same: a compiler that does not name
its build, or names another, is refused; `null` leaves the runtime without a
compiler, and `undefined` takes its own again (the full build's bundled one,
or the registered one).
