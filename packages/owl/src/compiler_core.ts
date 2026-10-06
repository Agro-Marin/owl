// What the compiler takes from owl-core, in the compiler-only build: classes
// and constants with no state, so that the module carries no second owl-core.
// Its OwlError is its own class: the runtime rethrows such an error as its own.
export { OwlError } from "../../owl-core/src/owl_error";
export { EventModifier } from "../../owl-core/src/event_modifiers";
