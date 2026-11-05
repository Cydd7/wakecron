'use strict';
// Renders a JS value as an XML property list, the format launchd reads.
// Supports strings, integers, booleans, arrays and plain objects; anything else is a TypeError.

const HEADER = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
  '<plist version="1.0">',
];

const escape = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function render(value, depth, lines) {
  const indent = '\t'.repeat(depth);
  if (typeof value === 'string') {
    lines.push(`${indent}<string>${escape(value)}</string>`);
  } else if (typeof value === 'boolean') {
    lines.push(`${indent}<${value}/>`);
  } else if (Number.isInteger(value)) {
    lines.push(`${indent}<integer>${value}</integer>`);
  } else if (Array.isArray(value)) {
    if (value.length === 0) return lines.push(`${indent}<array/>`);
    lines.push(`${indent}<array>`);
    for (const item of value) render(item, depth + 1, lines);
    lines.push(`${indent}</array>`);
  } else if (value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const entries = Object.entries(value);
    if (entries.length === 0) return lines.push(`${indent}<dict/>`);
    lines.push(`${indent}<dict>`);
    for (const [key, item] of entries) {
      lines.push(`${indent}\t<key>${escape(key)}</key>`);
      render(item, depth + 1, lines);
    }
    lines.push(`${indent}</dict>`);
  } else {
    throw new TypeError(`plists can't hold ${value === null ? 'null' : typeof value} values (${String(value)})`);
  }
  return lines.length;
}

function toPlistXml(value) {
  const lines = [...HEADER];
  render(value, 0, lines);
  lines.push('</plist>', '');
  return lines.join('\n');
}

module.exports = { toPlistXml };
