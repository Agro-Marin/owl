import { OwlError } from "@odoo/owl-core";

/**
 * Parses an XML string into an XML document, throwing errors on parser errors
 * instead of returning an XML document containing the parseerror.
 *
 * @param xml the string to parse
 * @returns an XML document corresponding to the content of the string
 */
export function parseXML(xml: string): XMLDocument {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xml, "text/xml");
  if (doc.getElementsByTagName("parsererror").length) {
    let msg = "Invalid XML in template.";
    const parsererrorText = doc.getElementsByTagName("parsererror")[0].textContent;
    if (parsererrorText) {
      msg += "\nThe parser has produced the following error message:\n" + parsererrorText;
      // "line 3 at column 5" (Chrome), "Line Number 3, Column 5" after a
      // location url (Firefox), "3:5:" (jsdom)
      const position =
        /line(?: number)?\s+(\d+)\D+?column\s+(\d+)/i.exec(parsererrorText) ||
        /(\d+)\D+(\d+)/.exec(parsererrorText);
      if (position) {
        const lineNumber = Number(position[1]);
        const column = Number(position[2]);
        const line = xml.split("\n")[lineNumber - 1];
        if (line && column >= 1 && column <= line.length) {
          msg +=
            `\nThe error might be located at xml line ${lineNumber} column ${column}\n` +
            `${line}\n${"-".repeat(column - 1)}^`;
        }
      }
    }
    throw new OwlError(msg);
  }

  return doc;
}
