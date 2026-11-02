import { describe, expect, it } from 'vitest';
import { execRule, previewRule, previewHostname, validateOverrides, authorizeMessage } from '../src/core/security';
describe('credential boundaries', () => {
  it('limits terminal credentials to this extension and the exact Sprite API path', () => {
    const rule = execRule(1, 'demo-123', 'secret', 'extension-id');
    expect(rule.condition.initiatorDomains).toEqual(['extension-id']);
    expect(rule.condition.resourceTypes).toEqual(['websocket']);
    const rx = new RegExp(rule.condition.regexFilter!);
    expect(rx.test('wss://api.sprites.dev/v1/sprites/demo-123/exec?tty=true')).toBe(true);
    expect(rx.test('wss://api.sprites.dev/v1/sprites/demo-123/exec/123')).toBe(true);
    for (const u of ['wss://api.sprites.dev.evil/v1/sprites/demo-123/exec', 'wss://api.sprites.dev/v1/sprites/other/exec', 'wss://api.sprites.dev/v1/sprites/demo-123/exec/123/kill']) expect(rx.test(u)).toBe(false);
  });
  it('uses only the dedicated preview header, exact hostname, and one tab', () => {
    const rule = previewRule(2, 'https://demo-123.sprites.app', 9, 'secret');
    expect(rule.condition.tabIds).toEqual([9]);
    expect(rule.condition.resourceTypes).toContain('main_frame');
    const rx = new RegExp(rule.condition.regexFilter!);
    expect(rx.test('https://demo-123.sprites.app/')).toBe(true);
    expect(rx.test('wss://demo-123.sprites.app/hmr')).toBe(true);
    expect(rx.test('https://demo-123.sprites.app.evil/')).toBe(false);
    expect(rule.action.requestHeaders?.[0].header).toBe('X-Sprites-Authorization');
    expect(()=>previewHostname('https://evil.test/')).toThrow();
    expect(()=>previewHostname('https://demo.sprites.app/?token=bad')).toThrow();
  });
  it('prevents content scripts from reading profiles, opening terminals, or invoking arbitrary API commands', () => {
    const sender = {id:'self',url:'https://github.com/acme/demo',tab:{id:4}} as chrome.runtime.MessageSender;
    expect(()=>authorizeMessage({type:'snapshot'},sender,'self')).toThrow();
    expect(()=>authorizeMessage({type:'app_connection',id:'a'.repeat(36)},sender,'self')).toThrow();
    expect(()=>authorizeMessage({type:'hermes_connection',id:'a'.repeat(36)},sender,'self')).toThrow();
    expect(()=>authorizeMessage({type:'launch',url:'https://github.com/other/repo'},sender,'self')).toThrow();
    expect(()=>authorizeMessage({type:'launch',url:sender.url},sender,'self')).not.toThrow();
    expect(()=>authorizeMessage({type:'launch',url:sender.url,forceNew:true},sender,'self')).toThrow();
  });
  it('rejects path traversal and invalid manual ports', () => {
    for (const directory of ['../escape','/tmp/escape','a/../../escape']) expect(()=>validateOverrides({directory,installCommand:'',startCommand:'npm start',port:8080})).toThrow();
    expect(()=>validateOverrides({directory:'.',installCommand:'',startCommand:'npm start',port:70000})).toThrow();
  });
});
