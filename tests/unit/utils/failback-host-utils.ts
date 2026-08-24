import { expect } from 'chai';
import { normalizeHosts } from '../../../src/utils/failback-host-utils';

describe('failback-host-utils', function () {
  it('keeps ordinary hosts and host:port', function () {
    expect(
      normalizeHosts(['backup.example.com', 'backup.example.com:8443']),
    ).to.deep.equal(['backup.example.com', 'backup.example.com:8443']);
  });

  it('extracts host from a full URL', function () {
    expect(
      normalizeHosts(['https://cdn.example.com:8443/ignored/path?x=1']),
    ).to.deep.equal(['cdn.example.com:8443']);
  });

  it('drops SPF, verification, and multi-token TXT records', function () {
    expect(
      normalizeHosts([
        'failback.example.com',
        'v=spf1 include:_spf.google.com ~all',
        'google-site-verification=abc',
        'cdn-a.example.com,cdn-b.example.com',
        '',
        '  ',
      ]),
    ).to.deep.equal(['failback.example.com']);
  });

  it('keeps bracketed and unbracketed IPv6 hosts', function () {
    expect(normalizeHosts(['[2001:db8::1]:9443', '2001:db8::1'])).to.deep.equal(
      ['[2001:db8::1]:9443', '2001:db8::1'],
    );
  });
});
