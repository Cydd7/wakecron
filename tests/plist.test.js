'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { toPlistXml } = require('../lib/plist');

test('renders every supported type, escaping strings and keys', () => {
  const xml = toPlistXml({ 'L&bel': 'a&b<c>', N: 7, Yes: true, No: false, List: ['x', 1], Nested: { K: 'v' }, E: [], F: {} });
  assert.equal(xml, [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '\t<key>L&amp;bel</key>', '\t<string>a&amp;b&lt;c&gt;</string>',
    '\t<key>N</key>', '\t<integer>7</integer>',
    '\t<key>Yes</key>', '\t<true/>',
    '\t<key>No</key>', '\t<false/>',
    '\t<key>List</key>', '\t<array>', '\t\t<string>x</string>', '\t\t<integer>1</integer>', '\t</array>',
    '\t<key>Nested</key>', '\t<dict>', '\t\t<key>K</key>', '\t\t<string>v</string>', '\t</dict>',
    '\t<key>E</key>', '\t<array/>',
    '\t<key>F</key>', '\t<dict/>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n'));
});

test('rejects values plists cannot hold', () => {
  for (const bad of [null, undefined, 1.5, NaN, () => 1]) assert.throws(() => toPlistXml({ k: bad }), TypeError);
});
