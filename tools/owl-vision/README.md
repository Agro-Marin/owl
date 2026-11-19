# 🦉 Owl Vision 🕶️

Owl Vision is an extension for the amazing [Owl framework](https://github.com/odoo/owl) that complements your templates with beautiful colors and allows you to more easily navigate between components and templates.

![Syntax highlight preview](https://raw.githubusercontent.com/odoo/owl/master/tools/owl-vision/assets/syntax_highlight.png)

This extension also adds:
- A basic component snippent.
- "Go to definition" providers for component tags in xml or in inline templates.

## Commands

* `Owl Vision: Find Template`:
    - If the cursor is on a template name, finds the corresponding template.
    - If the cursor is on a component, finds the template of the selected component.
* `Owl Vision: Find Component`: Finds the selected component definition.
* `Owl Vision: Switch`: Finds the corresponding template or component depending on the current file.
* `Owl Vision: Switch (Besides)`: Finds the corresponding template or component depending on the current file and opens it besides.
* `Owl Vision: Switch (Below)`: Finds the corresponding template or component depending on the current file and opens it below.
* `Owl Vision: Check Templates' Types`: Runs the template type checker now (it also runs on every save).

## Settings

* `owl-vision.include`: Glob filter for files to include while searching.
* `owl-vision.exclude`: Glob filter for files to exclude while searching.
* `owl-vision.templateTypes.command`: The template type checker, as a program and its arguments. Empty, the default, checks nothing.
* `owl-vision.templateTypes.cwd`: Its working directory, from the first workspace folder.
* `owl-vision.templateTypes.severity`: How its findings are shown: `error`, `warning` (the default), `information` or `hint`.

## Template types

A checker reads each template against its component class: OWL's `compileTypeShadow` (the node tool `owl.type_shadow.es.js`) writes the template's expressions as TypeScript with `this` typed as the component, tsc checks them, and the checker places each error at the attribute it comes from. Owl Vision runs it on save, shows its findings where they are written, and its count in the status bar; a save during a run replaces the run.

In an Odoo checkout opened as the workspace:

```json
"owl-vision.templateTypes.command": ["node", "tooling/typing/template_types.mjs", "--json"]
```

With the checkout in a subfolder of the workspace, `owl-vision.templateTypes.cwd` names it (`"odoo"`).

The checker prints one JSON object, `{ "findings": [...] }`, each finding:

| Key | |
|---|---|
| `file` | where it is written, absolute or from the checker's working directory; absent or null, it is counted, not shown |
| `line`, `column`, `endLine`, `endColumn` | from 1, the end exclusive |
| `code`, `message` | tsc's code and message (`loose`: the component takes any member, so its template's reads are not checked) |
| `template`, `component` | optional, added to the message |

## Troubleshooting

### *The extension cannot find my templates/components*

The include and exclude settings have default values that may not work with your project structure, try adapting them.
