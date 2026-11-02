import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Panels } from '../src/core/panels';

let values:Record<string,unknown>;
let open:ReturnType<typeof vi.fn>;
beforeEach(()=>{
  values={};open=vi.fn(async()=>{});
  vi.stubGlobal('chrome',{sidePanel:{open},storage:{session:{get:vi.fn(async(key:string)=>({[key]:values[key]})),set:vi.fn(async(data:Record<string,unknown>)=>{Object.assign(values,data);}),remove:vi.fn(async(key:string)=>{delete values[key];})}}});
});
describe('window progress bindings',()=>{
  it('opens synchronously while the browser click still has user activation',async()=>{
    const pending=new Panels().open(4);
    expect(open).toHaveBeenCalledExactlyOnceWith({windowId:4});
    await expect(pending).resolves.toBe(true);
  });
  it('allows full-tab fallback if Chrome refuses or lacks a side panel',async()=>{
    open.mockRejectedValueOnce(new Error('User activation expired'));
    await expect(new Panels().open(4)).resolves.toBe(false);
    open.mockImplementationOnce(()=>{throw new Error('Unavailable');});
    await expect(new Panels().open(4)).resolves.toBe(false);
  });
  it('preserves login-resume intent when the missing organization error arrives',async()=>{
    const panel=new Panels().intent(4,'https://github.com/acme/demo');
    await panel.activate();await panel.present(undefined,'https://github.com/acme/demo');await panel.fail('Connect an organization first');
    expect(values['launchPanel:4']).toMatchObject({stage:'login',sourceUrl:'https://github.com/acme/demo',error:'Connect an organization first'});
  });
  it('keeps the latest click selected when earlier GitHub lookups finish later',async()=>{
    const panels=new Panels();
    const old=panels.intent(4,'https://github.com/acme/old');await old.activate();
    const current=panels.intent(4,'https://github.com/acme/new');await current.activate();
    await current.present('new-launch');await old.present('old-launch');await old.fail('Stale error');
    expect(values['launchPanel:4']).toMatchObject({sourceUrl:'https://github.com/acme/new',stage:'launch',launchId:'new-launch'});
    expect(JSON.stringify(values)).not.toContain('Stale error');
  });
  it('isolates windows and removes closed-window context without reviving it',async()=>{
    const panels=new Panels(),one=panels.intent(4,'https://github.com/acme/one'),two=panels.intent(8,'https://github.com/acme/two');
    await Promise.all([one.activate(),two.activate()]);await two.present('two-launch');
    await panels.removeWindow(4);await one.present('one-launch');
    expect(values['launchPanel:4']).toBeUndefined();
    expect(values['launchPanel:8']).toMatchObject({launchId:'two-launch'});
  });
});
