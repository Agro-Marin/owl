// What owl's dist runs on, and all it runs on: the browsers Odoo's asset
// pipeline builds for (odoo/tools/assets/esbuild.py, _ESBUILD_TARGET
// "chrome154,firefox157,safari27") and the Node of its server, which runs owl
// to precompile templates. esbuild lowers nothing these all have; owl's
// sources may use any language feature and library API they all have
// (tests/dist.test.ts checks the dist for those they lack).
export const TARGET = ["chrome154", "firefox157", "safari27", "node26"];
