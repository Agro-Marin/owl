// What the compiler takes from owl-core, in the compiler-only build: the
// runtime's OwlError, so an error it throws is the class the page catches, and
// the event modifier bits, which are constants.
export { OwlError } from "@odoo/owl-runtime";
export { EventModifier } from "../../owl-core/src/event_modifiers";
