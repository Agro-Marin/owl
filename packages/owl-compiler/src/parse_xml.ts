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
      const re = /\d+/g;
      const firstMatch = re.exec(parsererrorText);
      if (firstMatch) {
        const lineNumber = Number(firstMatch[0]);
        const line = xml.split("\n")[lineNumber - 1];
        const secondMatch = re.exec(parsererrorText);
        if (line && secondMatch) {
          const column = Number(secondMatch[0]);
          if (column >= 1 && column <= line.length) {
            msg +=
              `\nThe error might be located at xml line ${lineNumber} column ${column}\n` +
              `${line}\n${"-".repeat(column - 1)}^`;
          }
        }
      }
    }
    throw new OwlError(msg);
  }

  return doc;
}
