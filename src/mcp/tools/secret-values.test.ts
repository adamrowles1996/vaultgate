// cspell:ignore amqps dbname rediss Vjcm
import { describe, expect, it } from 'vitest';

import { isSecretLookingValue } from './secret-values.ts';

/**
A PEM armour line, built so that no leak scanner mistakes this file for a key.
*/
function armour(label: string): string {
  const dashes = '-'.repeat(5);
  return `${dashes}${label}${dashes}`;
}

describe('isSecretLookingValue', () => {
  it.each([
    'Server=db.example.com;Database=app;User ID=svc;Password=made-up-1;',
    'Data Source=sql01;Initial Catalog=x;User Id=sa;password=made-up-2',
    'Driver={ODBC Driver 18};Server=sql01;UID=svc;PWD={made-up-3};',
    'host=pg01 port=5432 user=svc password=made-up-4 dbname=app',
    'host=pg01 password=made-up-4',
    'Server=x\tPassword=made-up-4',
    'user=a, password=made-up-4',
    'DefaultEndpointsProtocol=https;AccountName=acct;AccountKey=bWFkZS11cA==;',
    'Endpoint=sb://ns.example.net/;SharedAccessKeyName=root;SharedAccessKey=bWFkZS11cA=',
    'https://acct.blob.core.example.net/c?sv=2022-11-02&ss=b&sig=bWFkZS11cA%3D',
    'https://fn.example.net/api/hook?code=made-up-5',
    'https://api.example.com/hook?client_id=abc&client_secret=made-up-5',
    'jdbc:sqlserver://sql01;user=svc;Password = made-up-6',
    'password: made-up-6',
    '{"user":"svc","password":"made-up-7"}',
    'Authorization: Bearer made-up-token',
    'X-Api-Key: made-up-8',
    'Pass=made-up-8',
    'postgresql://svc:made-up-9@pg01.example.com:5432/app',
    'mongodb+srv://svc:made-up-9@cluster.example.net/db',
    'rediss://:made-up-9@cache.example.net:6380',
    'svc:made-up-9@db01:5432',
    'jdbc:oracle:thin:scott/made-up-9@db01:1521/ORCL',
    'line one\naccess_token=made-up-10',
    'amqps://user:c2VjcmV0==@host',
    'redis://:abc=def@h',
    'postgresql://u:a;b@h',
    'postgresql://u:a,b@h',
    'mysql://root:p@[::1]:3306',
    'scott/tiger@orcl',
    'Password=?abc',
    'Password=}x',
    'Password = "x',
    `${armour('BEGIN OPENSSH PRIVATE KEY')}\nbWFkZS11cA==\n${armour('END OPENSSH PRIVATE KEY')}`,
    armour('BEGIN PRIVATE KEY'),
    'x'.repeat(8193),
  ])('MCP-18 treats %j as secret-looking', (value) => {
    expect(isSecretLookingValue(value)).toBe(true);
  });

  it.each([
    '',
    'production',
    'db.example.com',
    'db.example.com:1433',
    'alice@example.com',
    'Server=db.example.com;Database=app;User ID=svc;',
    'Server=db.example.com;Password=;',
    'Server=db.example.com;Password="";',
    'Server=db.example.com;PWD={};',
    'Password',
    '=made-up',
    'https://app.example.com/login?next=home&tab=keys',
    'postgresql://svc@pg01.example.com:5432/app',
    'Integrated Security=SSPI;Server=sql01',
    'Region: uk-south',
    'https://example.com/a:b@c',
    'mysql://root:@h',
    'Password=}',
    armour('BEGIN PUBLIC KEY'),
    'x'.repeat(8192),
  ])('MCP-18 leaves %j readable', (value) => {
    expect(isSecretLookingValue(value)).toBe(false);
  });

  it('MCP-18 answers the same on repeated calls', () => {
    const value = 'Server=x;Password=made-up;';
    expect([1, 2, 3].map(() => isSecretLookingValue(value))).toStrictEqual([true, true, true]);
  });

  it('MCP-18 scans a long adversarial value in linear time', () => {
    const values = [
      'a'.repeat(8192),
      `${'a'.repeat(4000)}://${'b'.repeat(4000)}`,
      `a="${'b'.repeat(8000)}`,
      'a:'.repeat(4096),
      'a/'.repeat(4096),
    ];
    const started = performance.now();
    for (const value of values) {
      isSecretLookingValue(value);
    }
    expect(performance.now() - started).toBeLessThan(500);
  });
});
