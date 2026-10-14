# Tools

- **devtools/**: Browser extension (Chrome/Firefox) for debugging Owl components. Provides a devtools panel to inspect component tree, state, and lifecycle.
- **playground/build_monaco.mjs**: Bundles the Monaco editor and its workers for the playground.
- **compile_owl_templates.mjs**: CLI tool that compiles Owl XML templates into JavaScript. Reads template files from provided paths and writes compiled output to a file.
- **playground/server.py**: Python HTTP server that serves the playground locally, resolving Owl builds and disabling caching. Run with `npm run playground:serve`.
- **odoo_migration/**: Odoo template migration and compilation checks, including template inheritance comparisons between Owl builds.
- **release.mjs**: Automated release script handling version bumping, testing, building (including devtools), git commits, GitHub release creation, and NPM publishing.
