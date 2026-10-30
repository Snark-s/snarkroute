// Controlled isolated Chromium fixture, never the owner's Chrome/Profile 13.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
const root='Y:/Приложения/Бужа/browser-extension-review-2026-10-29';
const {pageOperation}=await import(pathToFileURL(root+'/src/page-operation.js'));
const {publicUrl,publicTitle}=await import(pathToFileURL(root+'/src/guard.js'));
const {chromium}=createRequire('I:/PersonaCore/extension/package.json')('playwright');
test('visible submit labels, image metadata and safe Gmail message URLs; private input values stay excluded',async()=>{
  assert.equal(publicUrl('https://mail.google.com/mail/u/0/#sent/ABCDEFGHIJKLMNOP'),'https://mail.google.com/mail/u/0/#sent/ABCDEFGHIJKLMNOP');
  assert.equal(publicUrl('https://mail.google.com/mail/u/0/#access_token=secret'),'https://mail.google.com/mail/u/0/');
  assert.equal(publicUrl('https://accounts.google.com/#sent/ABCDEFGHIJKLMNOP'),'https://accounts.google.com/');
  assert.equal(publicTitle('accounts.google.com/info/sessionexpired?TL=private-auth-marker&rart=private-secondary-marker'),'https://accounts.google.com/info/sessionexpired');
  assert.equal(publicTitle('Портфолио Бужи'),'Портфолио Бужи');
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try{
    const page=await browser.newPage();
    await page.route('**/*',route=>route.fulfill({contentType:'text/html; charset=utf-8',body:'<form><input id="title" value="private-draft-do-not-leak"><input id="save" type="submit" value="Сохранить"><input type="password" value="secret-do-not-leak"></form><label for="title">Заголовок</label><img alt="Аватар Бужи" style="width:10px;height:10px" src="/avatar.png"><img hidden src="/private.png">'}));
    await page.goto('https://mail.google.com/mail/u/0/#sent/ABCDEFGHIJKLMNOP');
    const snapshot=await page.evaluate(pageOperation,{op:'snapshot',expected_url:page.url(),max_chars:6000,element_limit:50});
    assert.equal(snapshot.url,page.url());
    assert.equal(snapshot.elements.find(e=>e.id==='save').label,'Сохранить');
    assert.equal(snapshot.images.length,1);assert.equal(snapshot.images[0].alt,'Аватар Бужи');
    assert(!JSON.stringify(snapshot).includes('private-draft-do-not-leak'));assert(!JSON.stringify(snapshot).includes('secret-do-not-leak'));
    const found=await page.evaluate(pageOperation,{op:'find',expected_url:page.url(),query:'Сохранить',exact:true,limit:10});
    assert.equal(found.matches.length,1);assert.equal(found.matches[0].selector,'#save');
  }finally{await browser.close();}
});
