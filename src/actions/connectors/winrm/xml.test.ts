import { describe, expect, it } from 'vitest';

import { at, child, descendants, parseXml, XmlProblem } from './xml.ts';

const ENVELOPE =
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<s:Envelope xmlns:s="urn:soap" xmlns:rsp="urn:shell">' +
  '<s:Header><a:Action>urn:Receive</a:Action></s:Header>' +
  '<s:Body><rsp:ReceiveResponse>' +
  '<rsp:Stream Name="stdout" End=\'true\'>aGk=</rsp:Stream>' +
  '<rsp:Stream Name="stderr"/>' +
  '<rsp:CommandState State="urn:Done"><rsp:ExitCode>0</rsp:ExitCode></rsp:CommandState>' +
  '</rsp:ReceiveResponse></s:Body></s:Envelope>';

function refuses(text: string): string {
  try {
    parseXml(text);
  } catch (error: unknown) {
    return error instanceof XmlProblem ? error.message : 'not an XmlProblem';
  }
  return 'accepted';
}

describe('parseXml', () => {
  it('ACT-90 reads the elements, attributes and text of a Receive response', () => {
    const envelope = parseXml(ENVELOPE);
    expect(envelope.name).toBe('s:Envelope');
    expect(envelope.local).toBe('Envelope');
    expect(at(envelope, 'Header', 'Action')?.text).toBe('urn:Receive');
    const streams = descendants(envelope, 'Stream');
    expect(streams.map((stream) => stream.attributes['Name'])).toStrictEqual(['stdout', 'stderr']);
    expect(streams[0]?.attributes['End']).toBe('true');
    expect(streams[0]?.text).toBe('aGk=');
    expect(streams[1]?.text).toBe('');
    expect(streams[1]?.children).toStrictEqual([]);
    expect(descendants(envelope, 'CommandState')[0]?.attributes['State']).toBe('urn:Done');
    expect(at(envelope, 'Body', 'ReceiveResponse', 'CommandState', 'ExitCode')?.text).toBe('0');
  });

  it('T33 refuses a DOCTYPE, a comment, a CDATA section and a second processing instruction', () => {
    expect(refuses('<!DOCTYPE a><a></a>')).toContain('expected an element or attribute name');
    expect(refuses('<a><!-- hello --></a>')).toContain('not accepted here');
    expect(refuses('<a><![CDATA[x]]></a>')).toContain('not accepted here');
    expect(refuses('<a><?php ?></a>')).toContain('not accepted here');
  });

  it('T33 refuses a reference anywhere rather than evaluating it', () => {
    expect(refuses('<a>&lt;</a>')).toContain('character data contains a reference');
    expect(refuses('<a>&xxe;</a>')).toContain('character data contains a reference');
    expect(refuses('<a b="&amp;"></a>')).toContain('an attribute value contains a reference');
  });

  it('T33 refuses a document that is not well formed', () => {
    expect(refuses('<a><b></c></a>')).toContain('is closed by another tag');
    expect(refuses('<a>')).toContain('an element is not closed');
    expect(refuses('<a></a><b></b>')).toContain('more than one root element');
    expect(refuses('  ')).toContain('expected <');
    expect(refuses('<1a></1a>')).toContain('expected an element or attribute name');
    expect(refuses('<a b></a>')).toContain('expected =');
    expect(refuses('<a b=x></a>')).toContain('expected a quoted attribute value');
    expect(refuses('<a b="x></a>')).toContain('an attribute value is not closed');
    expect(refuses('<?xml version="1.0"')).toContain('the XML declaration is not closed');
  });

  it('T33 caps depth, element count and attribute count', () => {
    const deep = '<a>'.repeat(30) + '</a>'.repeat(30);
    expect(refuses(deep)).toContain('nested deeper');
    const wide = `<a>${'<b></b>'.repeat(5000)}</a>`;
    expect(refuses(wide)).toContain('more elements');
    const attributes = Array.from({ length: 40 }, (_value, index) => `x${index}="1"`).join(' ');
    expect(refuses(`<a ${attributes}></a>`)).toContain('more attributes');
  });
});

describe('child, at and descendants', () => {
  it('ACT-90 answer undefined for a step that is not there', () => {
    const envelope = parseXml(ENVELOPE);
    expect(child(envelope, 'Missing')).toBeUndefined();
    expect(at(envelope, 'Body', 'Missing', 'Deeper')).toBeUndefined();
    expect(descendants(envelope, 'Missing')).toStrictEqual([]);
  });
});
