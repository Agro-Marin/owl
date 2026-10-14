import jsdom from "jsdom";

var document = new jsdom.JSDOM("", {});
var window = document.window;
global.document = window.document;
global.window = window as unknown as Window & typeof globalThis;
global.DOMParser = window.DOMParser;
global.Element = window.Element;
global.Node = window.Node;
