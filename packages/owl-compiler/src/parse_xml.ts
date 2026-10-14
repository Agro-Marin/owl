import { OwlError } from "@odoo/owl-core";

export function parseXML(xml: string): XMLDocument {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xml, "text/xml");
  if (doc.getElementsByTagName("parsererror").length) {
    let msg = "Invalid XML in template.";
    const parsererrorText = doc.getElementsByTagName("parsererror")[0].textContent;
    if (parsererrorText) {
      msg += "\nThe parser has produced the following error message:\n" + parsererrorText;
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
