/* Headless browser regression; needs Playwright (or the bundled Codex runtime).
   Uses its own temporary backend/data; never touches the user's app.db. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const {spawn, execFileSync} = require('node:child_process');
const { chromium } = require(require.resolve('playwright', {paths: [path.join(__dirname,'../frontend'), __dirname]}));

const root = path.resolve(__dirname, '..');
const python = path.join(root, '.venv', process.platform === 'win32' ? 'Scripts' : 'bin', process.platform === 'win32' ? 'python.exe' : 'python');
fs.mkdirSync(path.join(root, 'data'), {recursive: true});
const tmp = fs.mkdtempSync(path.join(root, 'data', 'browser-regression-'));
const pdf = path.join(tmp, 'browser.pdf');
execFileSync(python, ['-c', `import pymupdf,sys,io
from PIL import Image,ImageDraw,ImageFont
im=Image.new('RGB',(900,360),'white');draw=ImageDraw.Draw(im)
font=next((ImageFont.truetype(p,32) for p in ('C:/Windows/Fonts/arial.ttf','/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf','/System/Library/Fonts/Supplemental/Arial.ttf') if __import__('pathlib').Path(p).exists()),ImageFont.load_default(size=32))
for y,text in ((40,'Input layer'),(140,'Output layer'),(240,'x = 2   100 ms')):draw.text((50,y),text,fill='black',font=font)
png=io.BytesIO();im.save(png,format='PNG')
pdf=pymupdf.open()
for i in range(36):
 p=pdf.new_page()
 if i==3:
  title='Document Structure';width=pymupdf.get_text_length(title,fontname='hebo',fontsize=22)
  p.insert_text(((p.rect.width-width)/2,120),title,fontname='hebo',fontsize=22)
  p.insert_text((72,330),'1. Introduction',fontname='hebo',fontsize=12)
 else:p.insert_text((72,120),f'Chapter {i+1}: browser regression',fontsize=16)
 if i!=6:p.insert_textbox(pymupdf.Rect(72,160,500,300),f'Page {i+1}. An example transformer paragraph for browser selection and translation. '*5,fontsize=11)
 else:
  for row in range(6):
   p.insert_text((72,170+row*18),f'Left column sentence {row+1} ends here.',fontsize=10)
   p.insert_text((330,170+row*18),f'Right column distractor {row+1} stays separate.',fontsize=10)
 if i==3:p.insert_image(pymupdf.Rect(72,350,500,521.2),stream=png.getvalue())
 if i==3:p.insert_text((72,540),'Figure 1: Input and output layers.',fontsize=9)
 if i==4:
  p.insert_text((72,350),'References',fontname='hebo',fontsize=12)
  p.insert_text((72,380),'[1] Alice Smith. Unrelated paper title. 2024.',fontsize=10)
 if i==5:
  p.insert_text((72,350),'Appendix A: Additional Experiments',fontname='hebo',fontsize=14)
  p.insert_text((72,385),'Appendix body must be translated.',fontsize=10)
pdf.save(sys.argv[1])`, pdf], {windowsHide: true});

function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
async function freePort() {
  const s = net.createServer();
  await new Promise(resolve => s.listen(0, '127.0.0.1', resolve));
  const port = s.address().port;
  await new Promise(resolve => s.close(resolve));
  return port;
}

async function main() {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const stub = http.createServer((req,res) => {
    let body='';req.on('data',chunk=>body+=chunk);
    req.on('end',()=>{
      const message=JSON.parse(body).messages.at(-1).content;
      const numbers=typeof message === 'string' ? [...message.matchAll(/<<<(\d+)>>>/g)].map(m=>m[1]) : [];
      setTimeout(()=>{res.writeHead(200,{'Content-Type':'application/json'});
        res.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:Array.isArray(message) ? 'Input layer → 视觉识别的输入层' : numbers.map(n=>`<<<${n}>>>\n延迟后的中文译文`).join('\n')}}]}));},3200);
    });
  });
  await new Promise(resolve=>stub.listen(0,'127.0.0.1',resolve));
  const stubUrl=`http://127.0.0.1:${stub.address().port}/v1`;
  const env = {...process.env, APP_DATA_DIR: tmp, APP_ACCESS_TOKEN: '', APP_PORT:String(port), PYTHONIOENCODING: 'utf-8', BROWSER_TEST_KEY:'offline-test-key'};
  const server = spawn(python, ['-m','uvicorn','app.main:app','--host','127.0.0.1','--port',String(port)],
    {cwd: path.join(root,'backend'), env, windowsHide: true, stdio: ['ignore','pipe','pipe']});
  let logs = '';
  server.stdout.on('data', data => logs += data);
  server.stderr.on('data', data => logs += data);
  let browser;
  try {
    let ready = false;
    for (let i=0; i<100; i++) {
      try { ready = (await fetch(`${base}/api/health`)).ok; } catch {}
      if (ready) break;
      if (server.exitCode !== null) throw new Error(logs);
      await delay(100);
    }
    assert(ready, `backend did not start: ${logs}`);
    const data = new FormData();
    data.append('file', new Blob([fs.readFileSync(pdf)], {type:'application/pdf'}), 'browser.pdf');
    const upload = await fetch(`${base}/api/documents`, {method:'POST',body:data});
    if(!upload.ok) throw new Error(await upload.text());
    const doc = await upload.json();
    for(let i=0; i<100; i++) {
      const state = await (await fetch(`${base}/api/documents/${doc.id}`)).json();
      if(state.status==='ready') break;
      await delay(100);
    }
    const blocks = await (await fetch(`${base}/api/documents/${doc.id}/blocks`)).json();
    assert(blocks.length>0);
    // Emulate an old import whose figure captions were suppressed. Reading it
    // must repair source blocks without reparsing the already saved body IDs.
    execFileSync(python,['-c',`import sqlite3,sys
c=sqlite3.connect(sys.argv[1]);c.execute("delete from translationsegment where block_id in (select id from block where document_id=? and block_type='caption')",(int(sys.argv[2]),));c.execute("delete from block where document_id=? and block_type='caption'",(int(sys.argv[2]),));c.commit()`,path.join(tmp,'app.db'),String(doc.id)],{windowsHide:true});
    // Force PDF loading behind metadata loading to exercise the restoration race.
    browser = await chromium.launch({headless:true, channel:process.env.PLAYWRIGHT_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined)});
    const page = await browser.newPage({viewport:{width:1280,height:900}});
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route(`**/api/documents/${doc.id}/file`, async route => {
      await delay(700);
      await route.continue();
    });
    await page.goto(`${base}/#/read/${doc.id}?page=3`);
    const sourcePage3 = page.locator('[data-pdf-page="3"]').first();
    await sourcePage3.locator('.textLayer span').first().waitFor({state:'attached',timeout:20000});
    const scroll = await sourcePage3.evaluate(el => el.closest('.overflow-auto').scrollTop);
    assert(scroll>500, `saved/URL page restoration failed: ${scroll}`);
    console.log('PASS delayed PDF restores URL page 3 and lazy text layer loads');
    const repairedBlocks=await(await fetch(`${base}/api/documents/${doc.id}/blocks`)).json();
    assert(repairedBlocks.some(b=>b.block_type==='caption' && b.text.startsWith('Figure 1:')));
    assert(blocks.filter(b=>b.block_type!=='caption').every(b=>repairedBlocks.some(r=>r.id===b.id)));
    console.log('PASS opening a legacy paper automatically restores missing caption blocks without replacing body IDs');
    const catalog=await(await fetch(`${base}/api/model-adapters`)).json();
    assert.deepEqual(catalog,{text:['openai'],vision:['openai'],ocr:['rapidocr'],layout:['doclayout']});
    await page.locator('[title="翻译设置"]').click();
    const settingsDialog=page.getByRole('dialog',{name:'翻译设置',exact:true});
    await settingsDialog.getByLabel('翻译服务商').selectOption('openai');
    assert.equal(await settingsDialog.getByLabel('文本服务类型').inputValue(),'openai');
    await settingsDialog.getByText('区域图片识别模型',{exact:true}).click();
    assert.equal(await settingsDialog.getByLabel('视觉服务类型').inputValue(),'openai');
    await settingsDialog.getByRole('button',{name:'关闭翻译设置',exact:true}).click();
    console.log('PASS adapter catalog and service selectors preserve defaults without loading optional models');
    const toolbar=page.getByRole('toolbar',{name:'阅读工具栏'});
    assert.equal(await toolbar.getByText('Shift + 拖动：框选图片 / 表格',{exact:true}).count(),0);
    assert.equal(await toolbar.locator('[title*="用本地 OCR"]').count(),0);
    assert.equal(await toolbar.getByRole('button',{name:'手形工具',exact:true}).locator('svg').count(),1);
    assert.equal(await toolbar.getByRole('button',{name:'手形工具',exact:true}).innerText(),'');
    assert(await toolbar.evaluate(el=>el.scrollWidth<=el.clientWidth+1),'reader toolbar overflows at 1280px');
    await page.getByRole('button',{name:'快捷键帮助',exact:true}).click();
    await page.getByRole('dialog',{name:'键盘快捷键'}).getByText('Shift + 拖动',{exact:true}).waitFor();
    await page.getByRole('button',{name:'关闭键盘快捷键',exact:true}).click();
    console.log('PASS compact SVG toolbar fits desktop width and region-selection instructions live in help');

    const width = await sourcePage3.evaluate(el => el.getBoundingClientRect().width);
    await page.setViewportSize({width:820,height:900});
    await page.waitForFunction(previous => document.querySelector('[data-pdf-page="3"]').getBoundingClientRect().width < previous-100, width);
    const resized = await sourcePage3.evaluate(el => el.getBoundingClientRect().width);
    assert(resized<width-100);
    await page.waitForFunction(()=>{
      const canvas=document.querySelector('[data-pdf-page="3"] canvas');
      if(!canvas?.width||!canvas.height)return false;
      const pixels=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
      for(let i=0;i<pixels.length;i+=4) if(pixels[i]<150&&pixels[i+1]<150&&pixels[i+2]<150&&pixels[i+3]>0)return true;
      return false;
    });
    console.log('PASS fit-to-width reacts to viewport resize');

    // Reader zoom must not magnify the browser, and the point under the mouse
    // stays stable. Oversized pages expose their left edge at scrollLeft=0.
    const panPane=page.locator('[data-pdf-scroll="source"]');
    const box=await panPane.boundingBox();
    const pivot={x:box.x+box.width*.5,y:box.y+180};
    await page.mouse.move(pivot.x,pivot.y);
    const localPoint=()=>sourcePage3.evaluate((el,p)=>{
      const r=el.getBoundingClientRect();return [(p.x-r.left)/r.width,(p.y-r.top)/r.height];
    },pivot);
    const originalPoint=await localPoint();
    await page.keyboard.down('Control');
    for(let i=0;i<5;i++) {
      const before=await sourcePage3.evaluate(el=>el.getBoundingClientRect().width);
      await page.mouse.wheel(0,-100);
      await page.waitForFunction(w=>document.querySelector('[data-pdf-page="3"]').getBoundingClientRect().width>w+10,before);
    }
    await page.keyboard.up('Control');
    assert.equal(await page.evaluate(()=>innerWidth),820);
    const afterPoint=await localPoint();
    assert(Math.abs(originalPoint[0]-afterPoint[0])<.015);
    assert(Math.abs(originalPoint[1]-afterPoint[1])<.015);
    await panPane.evaluate(el=>el.scrollLeft=0);
    assert((await sourcePage3.boundingBox()).x>=box.x);
    await page.keyboard.press('h');
    assert.equal(await page.getByRole('button',{name:'手形工具',exact:true}).getAttribute('aria-pressed'),'true');
    const startScroll=await panPane.evaluate(el=>[el.scrollLeft,el.scrollTop]);
    await page.mouse.move(pivot.x,pivot.y);await page.mouse.down();
    await page.mouse.move(pivot.x-100,pivot.y-55,{steps:8});await page.mouse.up();
    await page.waitForFunction(()=>{
      const l=document.querySelector('[data-pdf-scroll="source"]'),r=document.querySelector('[data-pdf-scroll="translation"]');
      return Math.abs(l.scrollLeft-r.scrollLeft)<2 && Math.abs(l.scrollTop-r.scrollTop)<2;
    });
    const endScroll=await panPane.evaluate(el=>[el.scrollLeft,el.scrollTop]);
    assert(endScroll[0]>=startScroll[0]+90 && endScroll[1]>=startScroll[1]+45);
    assert.equal(await page.evaluate(()=>getSelection().toString()),'');
    await page.keyboard.press('h');
    await page.keyboard.down('Space');
    await page.mouse.move(pivot.x,pivot.y);await page.mouse.down();
    await page.mouse.move(pivot.x+45,pivot.y+20,{steps:5});await page.mouse.up();
    await page.keyboard.up('Space');
    const spaceScroll=await panPane.evaluate(el=>el.scrollLeft);
    assert(spaceScroll<endScroll[0]-35);
    await page.mouse.move(pivot.x,pivot.y);await page.mouse.down({button:'middle'});
    await page.mouse.move(pivot.x-35,pivot.y,{steps:5});await page.mouse.up({button:'middle'});
    assert((await panPane.evaluate(el=>el.scrollLeft))>spaceScroll+25);
    await page.keyboard.press('Control+0');
    await page.keyboard.press('k');await page.keyboard.press('j');
    console.log('PASS Ctrl+wheel anchors PDF zoom; hand, Space and middle-button drags pan both axes and mirror panes without selecting text');

    // Actual mouse drags, rather than constructing a Range, exercise endpoint precision.
    const phrase='An example transformer paragraph for browser selection and translation.';
    const dragPoints=await sourcePage3.evaluate((el,phrase)=>{
      const span=[...el.querySelectorAll('.textLayer span')].find(s=>s.textContent.includes(phrase));
      const node=span.firstChild,start=node.textContent.indexOf(phrase),end=start+phrase.length;
      const point=(index,end)=>{const r=document.createRange();r.setStart(node,index);r.setEnd(node,index+1);const b=r.getBoundingClientRect();return {x:end?b.right-b.width*.15:b.left+b.width*.15,y:(b.top+b.bottom)/2};};
      return {start:point(start,false),end:point(end-1,true)};
    },phrase);
    for(const [start,end] of [[dragPoints.start,dragPoints.end],[dragPoints.end,dragPoints.start]]) {
      await page.mouse.move(start.x,start.y);await page.mouse.down();
      await page.mouse.move(end.x,end.y,{steps:12});await page.mouse.up();
      assert.equal(await page.evaluate(()=>getSelection().toString().replace(/\s+/g,' ').trim()),phrase);
      await page.getByRole('button',{name:'高亮并附注',exact:true}).waitFor();
    }
    await sourcePage3.click({position:{x:8,y:8}});
    console.log('PASS real forward and reverse mouse drags select exactly one complete sentence');
    const wordPoint=await sourcePage3.evaluate(el=>{
      const span=[...el.querySelectorAll('.textLayer span')].find(s=>s.textContent.includes('example'));
      const offset=span.textContent.indexOf('example')+3;
      const range=document.createRange();range.setStart(span.firstChild,offset);range.setEnd(span.firstChild,offset+1);
      const box=range.getBoundingClientRect();return {x:(box.left+box.right)/2,y:(box.top+box.bottom)/2};
    });
    await page.mouse.dblclick(wordPoint.x,wordPoint.y);
    assert.equal(await page.evaluate(()=>getSelection().toString().trim()),'example');
    await sourcePage3.click({position:{x:8,y:8}});
    console.log('PASS double-click selects a word without the paragraph popover blocking the second click');

    // Open a real selection on page 3 using PDF.js generated spans.
    await sourcePage3.scrollIntoViewIfNeeded();
    await sourcePage3.locator('.textLayer span').first().waitFor({state:'attached'});
    await sourcePage3.evaluate(el => {
      const span=[...el.querySelectorAll('.textLayer span')].find(s=>s.textContent.includes('example'));
      if(!span) throw new Error('PDF text span missing');
      const range=document.createRange(); range.setStart(span.firstChild,0); range.setEnd(span.firstChild,25);
      const selection=getSelection();selection.removeAllRanges();selection.addRange(range);
      span.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,clientX:150,clientY:200}));
    });
    await page.getByRole('button',{name:'高亮并附注',exact:true}).click();
    await page.getByPlaceholder('添加附注…（Ctrl+Enter 完成）').fill('浏览器第3页附注');
    await page.getByRole('button',{name:'完成',exact:true}).click();
    await page.waitForFunction(async id => {
      const anns=await(await fetch(`/api/documents/${id}/annotations`)).json();
      return anns.some(a=>a.content==='浏览器第3页附注');
    },doc.id);
    console.log('PASS page 3 selection creates and saves Chinese highlight note');

    const firstAnnotation = (await(await fetch(`${base}/api/documents/${doc.id}/annotations`)).json())[0];
    await sourcePage3.evaluate(el => {
      const span=[...el.querySelectorAll('.textLayer span')].find(s=>s.textContent.includes('example'));
      const range=document.createRange();range.setStart(span.firstChild,32);range.setEnd(span.firstChild,70);
      const selection=getSelection();selection.removeAllRanges();selection.addRange(range);
      span.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,clientX:150,clientY:200}));
    });
    await page.getByRole('button',{name:'高亮并附注',exact:true}).click();
    await page.getByRole('dialog',{name:'编辑批注'}).waitFor();
    await page.getByPlaceholder('添加附注…（Ctrl+Enter 完成）').fill('第二条独立批注');
    await page.getByPlaceholder('添加附注…（Ctrl+Enter 完成）').press('End');
    await page.keyboard.type('x');
    await page.keyboard.press('Control+z');
    assert.equal(await page.getByPlaceholder('添加附注…（Ctrl+Enter 完成）').inputValue(),'第二条独立批注');
    assert.equal((await(await fetch(`${base}/api/documents/${doc.id}/annotations`)).json()).length,2);
    await page.getByRole('button',{name:'绿色',exact:true}).click();
    await page.getByRole('button',{name:'完成',exact:true}).click();
    await page.waitForFunction(async id => {
      const anns=await(await fetch(`/api/documents/${id}/annotations`)).json();
      return anns.length===2 && anns[1].color==='#bbf7d0';
    },doc.id);
    const twoAnnotations=await(await fetch(`${base}/api/documents/${doc.id}/annotations`)).json();
    assert.equal(twoAnnotations[0].id,firstAnnotation.id);
    assert.equal(twoAnnotations[0].color,'#fef08a');
    assert.equal(twoAnnotations[0].content,'浏览器第3页附注');
    assert.equal(twoAnnotations[0].block_id,twoAnnotations[1].block_id);
    assert.notEqual(twoAnnotations[0].id,twoAnnotations[1].id);
    assert.equal(twoAnnotations[1].selected_text.length,38);
    console.log('PASS two selections in one paragraph keep separate colors, quotes and notes');

    // Undo the saved edit, then the creation, and redo both. Restoration obtains
    // a new ID, while the earlier/later edit continues to address that record.
    await page.keyboard.press('Control+z');
    await page.getByRole('button',{name:'重做阅读操作',exact:true}).waitFor({state:'visible'});
    const historyAnnotations=()=>fetch(`${base}/api/documents/${doc.id}/annotations`).then(r=>r.json());
    await page.waitForFunction(async id=>{
      const a=await(await fetch(`/api/documents/${id}/annotations`)).json();return a.length===2 && a[1].color==='#fef08a';
    },doc.id);
    await page.getByRole('button',{name:'撤销阅读操作',exact:true}).click();
    await page.waitForFunction(async id=>(await(await fetch(`/api/documents/${id}/annotations`)).json()).length===1,doc.id);
    await page.getByRole('button',{name:'重做阅读操作',exact:true}).click();
    await page.waitForFunction(async id=>(await(await fetch(`/api/documents/${id}/annotations`)).json()).length===2,doc.id);
    await page.keyboard.press('Control+Shift+z');
    await page.waitForFunction(async id=>{
      const a=await(await fetch(`/api/documents/${id}/annotations`)).json();return a.length===2 && a[1].content==='第二条独立批注' && a[1].color==='#bbf7d0';
    },doc.id);
    // Subsequent test uses the restored identity rather than the deleted ID.
    const restoredAnnotations=await historyAnnotations();
    twoAnnotations[1]=restoredAnnotations.find(a=>a.id!==firstAnnotation.id);
    console.log('PASS Ctrl+Z and redo reverse annotation edits and creation, preserve independent colors and restore record identities');

    // Edit through the list. A failed save must leave the editor and draft intact.
    await page.getByRole('button',{name:'笔记与批注',exact:true}).click();
    await page.getByRole('button',{name:'编辑',exact:true}).last().click();
    await page.getByRole('dialog',{name:'编辑批注'}).waitFor();
    const popupBounds=await page.getByRole('dialog',{name:'编辑批注'}).boundingBox();
    assert(popupBounds.x>=0 && popupBounds.x+popupBounds.width<=820);
    const patchUrl=`**/api/documents/${doc.id}/annotations/${twoAnnotations[1].id}`;
    await page.route(patchUrl,route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({detail:'离线保存测试'})}));
    await page.getByPlaceholder('添加附注…（Ctrl+Enter 完成）').fill('失败后仍保留的草稿');
    await page.getByRole('button',{name:'完成',exact:true}).click();
    await page.getByRole('alert').filter({hasText:'草稿已保留'}).waitFor();
    assert.equal(await page.getByPlaceholder('添加附注…（Ctrl+Enter 完成）').inputValue(),'失败后仍保留的草稿');
    await page.unroute(patchUrl);
    await page.getByRole('button',{name:'完成',exact:true}).click();
    await page.getByRole('dialog',{name:'编辑批注'}).waitFor({state:'detached'});
    console.log('PASS annotation list editor stays in viewport and failed saves retain drafts for retry');

    // Verify browser download events and actual bytes for every export option.
    await page.getByRole('button',{name:'导出',exact:true}).click();
    const exports=[['双语对照 Markdown','.md'],['纯译文 Markdown','.md'],['英文原文 Markdown','.md'],['批注 PDF','.pdf'],['JSON 备份','.json']];
    for(const [label,ext] of exports) {
      const pendingDownload=page.waitForEvent('download');
      await page.getByRole('button').filter({hasText:label}).click();
      const download=await pendingDownload;
      assert.equal(await download.failure(),null);
      assert(download.suggestedFilename().endsWith(ext));
      const target=path.join(tmp,download.suggestedFilename());
      await download.saveAs(target);
      const bytes=fs.readFileSync(target);
      assert(bytes.length>0);
      if(ext==='.pdf') assert.equal(bytes.subarray(0,5).toString(),'%PDF-');
      if(ext==='.json') assert.equal(JSON.parse(bytes.toString()).annotations.length,2);
      if(ext==='.md') assert(bytes.toString().includes('浏览器第3页附注'));
    }
    console.log('PASS all five export options download nonempty PDF, Markdown and JSON files');
    const exportUrl=`**/api/documents/${doc.id}/export-annotated.pdf`;
    await page.route(exportUrl,route=>route.fulfill({status:500,contentType:'application/json',body:JSON.stringify({detail:'导出失败测试'})}));
    await page.getByRole('button').filter({hasText:'批注 PDF'}).click();
    await page.getByRole('alert').filter({hasText:'导出失败测试'}).waitFor();
    await page.unroute(exportUrl);
    await page.mouse.click(10,880);
    console.log('PASS export HTTP errors are shown instead of downloading an error response');


    // Switch to source-only view and navigate from the notes panel to page 3.
    await page.keyboard.press('2');
    await page.keyboard.press('k');
    await page.getByRole('button',{name:'笔记与批注',exact:true}).click();
    await page.getByRole('button').filter({hasText:'浏览器第3页附注'}).first().click();
    await page.waitForFunction(()=>document.querySelector('[data-pdf-page="3"]').closest('.overflow-auto').scrollTop>500);
    console.log('PASS notes panel navigates to the annotated page');
    await page.keyboard.press('Escape');

    // Translation runs in the isolated mock configuration.
    await page.getByRole('button',{name:/翻译全文|继续翻译/}).click();
    await page.waitForFunction(async id => {
      const d=await(await fetch(`/api/documents/${id}`)).json();
      return d.status==='ready'&&d.progress.translated>0;
    },doc.id);
    let finished;
    for(let attempt=0;attempt<200;attempt++) {
      finished=await (await fetch(`${base}/api/documents/${doc.id}`)).json();
      if(finished.status==='ready' && finished.progress.translated===finished.progress.total_blocks) break;
      await delay(100);
    }
    assert.equal(finished.error,null,JSON.stringify(finished));
    const listed=(await (await fetch(`${base}/api/documents`)).json()).find(d=>d.id===doc.id);
    assert.deepEqual(finished.progress,listed.progress);
    assert(finished.progress.translated<=finished.progress.total_blocks);
    assert.equal(finished.progress.translated,finished.progress.total_blocks);
    console.log('PASS library and reader progress agree and never exceed the current block total');
    await page.keyboard.press('1');
    await page.locator('[title^="原文："]').first().waitFor({state:'attached'});
    console.log('PASS completed translation updates overlays');

    // Zoom retains text/overlay DOM; hidden panes remain mounted and offscreen pages are lightweight.
    const sourceSpan=sourcePage3.locator('.textLayer span').first();
    await sourceSpan.evaluate(el=>el.dataset.retained='source-text');
    const overlayPage3=page.locator('[data-pdf-page="3"] [title^="原文："]').first();
    await overlayPage3.evaluate(el=>el.dataset.retained='translation-block');
    const fontBefore=await overlayPage3.locator('div').first().evaluate(el=>el.style.fontSize);
    for(let i=0;i<5;i++) await page.keyboard.press('+');
    assert.equal(await sourceSpan.getAttribute('data-retained'),'source-text');
    assert.equal(await overlayPage3.getAttribute('data-retained'),'translation-block');
    assert.equal(await overlayPage3.locator('div').first().evaluate(el=>el.style.fontSize),fontBefore);
    for(const mode of ['2','3','1','2','1']) await page.keyboard.press(mode);
    assert.equal(await sourceSpan.getAttribute('data-retained'),'source-text');
    assert.equal(await overlayPage3.getAttribute('data-retained'),'translation-block');
    await page.keyboard.press('0');
    await page.waitForFunction(()=>document.querySelector('[data-pdf-page="3"] canvas')?.dataset.rasterKey);
    const overlayCount=await page.locator('[title^="原文："]').count();
    assert(overlayCount<blocks.length/2,`offscreen overlays were mounted: ${overlayCount}/${blocks.length}`);
    const maintained=await sourcePage3.evaluate(el=>el.closest('.overflow-auto').scrollTop);
    assert(maintained>500,`switching views lost reading position: ${maintained}`);
    console.log('PASS repeated zoom/view switches reuse text and overlay DOM and preserve location on a 36-page PDF');

    await overlayPage3.click();
    await page.getByRole('button',{name:'加入笔记',exact:true}).click();
    await page.getByPlaceholder('记录你的理解、疑问或结论…').fill('段落笔记正文：记录模型的工作原理。');
    await page.getByRole('button',{name:'加入笔记',exact:true}).click();
    await page.getByText('段落笔记正文：记录模型的工作原理。',{exact:true}).waitFor();
    const linkedNote=(await(await fetch(`${base}/api/documents/${doc.id}/notes`)).json())[0];
    assert(linkedNote.block_id && linkedNote.quote && linkedNote.page_number===3);
    await page.getByPlaceholder('标题（可选）').fill('页级阅读笔记');
    await page.getByPlaceholder('记录你的理解、疑问或结论…').fill('页级笔记正文：本页尚待进一步阅读。');
    await page.getByRole('button',{name:'添加笔记',exact:true}).click();
    await page.getByText('页级笔记正文：本页尚待进一步阅读。',{exact:true}).waitFor();
    await page.getByLabel('笔记关联位置').selectOption('');
    await page.getByPlaceholder('标题（可选）').fill('整篇总结');
    await page.getByPlaceholder('记录你的理解、疑问或结论…').fill('全局笔记正文：最终总结与疑问。');
    await page.getByRole('button',{name:'添加笔记',exact:true}).click();
    await page.getByText('全局笔记正文：最终总结与疑问。',{exact:true}).waitFor();
    await page.getByRole('button',{name:'关闭阅读笔记',exact:true}).click();
    await page.getByRole('dialog',{name:'阅读笔记',exact:true}).waitFor({state:'detached'});
    await sourcePage3.locator(`[data-note-id="${linkedNote.id}"]`).waitFor();
    await sourcePage3.locator(`[data-note-id="${linkedNote.id}"]`).click();
    await page.locator(`[data-note-card="${linkedNote.id}"]`).waitFor();
    await page.getByRole('button',{name:'关闭阅读笔记',exact:true}).click();
    console.log('PASS paragraph notes retain quotes and page badges open saved notes; page/global notes are supported');

    await page.getByRole('button',{name:'导出',exact:true}).click();

    const paragraph=blocks.find(b=>b.page_number===3 && b.block_type==='paragraph');
    const paragraphMark=await(await fetch(`${base}/api/documents/${doc.id}/annotations`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({page_number:3,block_id:paragraph.id,kind:'comment',target:'source',bbox:paragraph.bbox,rects:[paragraph.bbox],content:'平直整段高亮测试'})})).json();
    assert(paragraphMark.rects.length>1);
    const pageMark=await(await fetch(`${base}/api/documents/${doc.id}/annotations`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({page_number:2,kind:'note',bbox:[],content:'没有矩形的页批注也要导出'})})).json();
    assert(pageMark.id);
    const noteDownload=page.waitForEvent('download');
    await page.getByRole('button').filter({hasText:'批注 PDF'}).click();
    const downloadedNotes=await noteDownload;
    const notePdf=path.join(tmp,'reading-notes.pdf');
    await downloadedNotes.saveAs(notePdf);
    const notesProof=execFileSync(python,['-c',`import pymupdf,sys,json
p=pymupdf.open(sys.argv[1]); original=36
text=''.join(page.get_text() for page in list(p)[original:])
for phrase in ('段落笔记正文','页级笔记正文','全局笔记正文','没有矩形的页批注也要导出'): assert phrase in text,phrase
assert any('没有矩形的页批注也要导出' in a.info['content'] for a in p[1].annots())
page=p[2]; highlight=next(a for a in page.annots() if a.info['content']=='平直整段高亮测试')
ref=int(p.xref_get_key(highlight.xref,'AP/N')[1].split()[0]); appearance=p.xref_stream(ref)
assert appearance.count(b' re f')>1 and b' c' not in appearance
assert len(p)>original
assert any(link['page']>=original for link in p[2].get_links())
assert any(link['page']==2 for link in p[original].get_links())
print(json.dumps({'pages':len(p),'appendix':len(p)-original}))`,notePdf],{windowsHide:true}).toString();
    assert(JSON.parse(notesProof).appendix>=1);
    if(process.env.PDF_QA_DIR) {
      const qa=path.resolve(process.env.PDF_QA_DIR);
      assert(qa.toLowerCase().startsWith(path.join(root,'data').toLowerCase()+path.sep));
      fs.mkdirSync(qa,{recursive:true});
      fs.copyFileSync(notePdf,path.join(qa,'reading-notes.pdf'));
      execFileSync(python,['-c','import pymupdf,sys,pathlib; p=pymupdf.open(sys.argv[1]); d=pathlib.Path(sys.argv[2]); p[2].get_pixmap(matrix=pymupdf.Matrix(1.3,1.3)).save(str(d/"source.png")); p[36].get_pixmap(matrix=pymupdf.Matrix(1.3,1.3)).save(str(d/"appendix.png"))',notePdf,qa],{windowsHide:true});
    }
    await page.mouse.click(10,880);
    console.log('PASS downloaded PDF contains visible Chinese note bodies, original-page markers and appendix backlinks');
    console.log('PASS paragraph highlights export with straight per-line edges and page annotations survive without rectangles');
    await page.goto(`${base}/#/read/${doc.id}?page=2`);
    await page.locator(`[data-pdf-page="2"] [data-annotation-id="${pageMark.id}"]`).first().waitFor();
    await page.getByRole('button',{name:`A${pageMark.id}`,exact:true}).click();
    await page.getByRole('dialog',{name:'编辑批注'}).waitFor();
    await page.getByPlaceholder('添加附注…（Ctrl+Enter 完成）').fill('没有矩形的页批注可以编辑');
    await page.getByRole('button',{name:'完成',exact:true}).click();
    await page.waitForFunction(async args => {
      const annotations=await(await fetch(`/api/documents/${args.doc}/annotations`)).json();
      return annotations.some(a=>a.id===args.ann && a.content==='没有矩形的页批注可以编辑' && a.kind==='note');
    },{doc:doc.id,ann:pageMark.id});
    await page.goto(`${base}/#/read/${doc.id}?page=3`);
    await page.locator('[data-pdf-page="3"] [title^="原文："]').first().waitFor();
    console.log('PASS page annotation without geometry has an editable page badge in the reader');



    await fetch(`${base}/api/settings`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({provider:'openai',openai:{base_url:stubUrl,model:'offline-stub',api_key_env:'BROWSER_TEST_KEY'}})});
    await page.locator('[title^="原文："]').first().click();
    await page.getByRole('button',{name:'重译此段',exact:true}).click();
    await page.getByText('延迟后的中文译文',{exact:true}).first().waitFor({state:'visible',timeout:15000});
    await page.keyboard.press('Escape');
    console.log('PASS 3.2-second single-segment translation refreshes after completion');

    // Leave and enter again: stale readers/workers must not overwrite the route.
    await page.goto(`${base}/#/`);
    await page.getByRole('link',{name:'阅读',exact:true}).click();
    await page.locator('[data-pdf-page="3"]').first().locator('.textLayer span').first().waitFor({state:'attached'});
    assert.equal(errors.length,0,errors.join('\n'));
    console.log('PASS reopen preserves saved location without browser exceptions');

    await page.goto(`${base}/#/read/${doc.id}?page=7`);
    const columnsPage=page.locator('[data-pdf-page="7"]').first();
    await columnsPage.locator('.textLayer span[data-pdf-block]').first().waitFor({state:'attached'});
    const columns=await columnsPage.evaluate(el=>{
      const spans=[...el.querySelectorAll('.textLayer span')];
      const left=spans.find(s=>s.textContent.includes('Left column sentence 1'));
      const right=spans.find(s=>s.textContent.includes('Right column distractor 3'));
      const a=left.getBoundingClientRect(),b=right.getBoundingClientRect();
      return {start:{x:a.left+1,y:(a.top+a.bottom)/2},end:{x:el.getBoundingClientRect().right+30,y:(b.top+b.bottom)/2}};
    });
    await page.mouse.move(columns.start.x,columns.start.y);await page.mouse.down();
    await page.mouse.move(columns.end.x,columns.end.y,{steps:14});await page.mouse.up();
    const columnSelection=await page.evaluate(()=>getSelection().toString());
    assert(columnSelection.includes('Left column sentence 3'),columnSelection);
    assert(!columnSelection.includes('Right column'),columnSelection);
    await page.getByRole('button',{name:'高亮',exact:true}).click();
    let columnMark;
    for(let i=0;i<60;i++) {
      columnMark=(await(await fetch(`${base}/api/documents/${doc.id}/annotations`)).json()).find(a=>a.page_number===7);
      if(columnMark) break;
      await delay(100);
    }
    assert.equal(columnMark.selected_text,'Left column sentence 1 ends here. Left column sentence 2 ends here. Left column sentence 3 ends here.');
    assert(columnMark.rects.every(r=>r[2]<300 && r[3]-r[1]<20),JSON.stringify(columnMark.rects));
    console.log('PASS interleaved two-column PDF drag stays in its column and saves precise text/rectangles after mouseup outside the page');

    await fetch(`${base}/api/settings`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({provider:'mock'})});
    await page.goto(`${base}/#/read/${doc.id}?page=4`);
    const figurePage=page.locator('[data-pdf-page="4"]').last();
    const mainTitle=figurePage.locator('[title="原文：Document Structure"]');
    const subTitle=figurePage.locator('[title="原文：1. Introduction"]');
    await mainTitle.waitFor();await subTitle.waitFor();
    for(const [title,size,align] of [[mainTitle,22,'center'],[subTitle,12,'left']]) {
      const style=await title.evaluate(el=>({weight:getComputedStyle(el).fontWeight,size:parseFloat(getComputedStyle(el.firstElementChild).fontSize),align:getComputedStyle(el).textAlign}));
      assert.equal(style.weight,'700');assert.equal(style.size,size);assert.equal(style.align,align);
    }
    await figurePage.locator('[data-overlay-type="caption"]').waitFor();
    const semanticBlocks=await(await fetch(`${base}/api/documents/${doc.id}/blocks`)).json();
    const reference=semanticBlocks.find(b=>b.text.includes('Alice Smith'));
    assert.equal(reference.block_type,'reference');assert.equal(reference.translation,null);
    assert(semanticBlocks.some(b=>b.text.includes('Appendix body')&&b.translation?.status==='done'));
    console.log('PASS titles keep original boldness, size and alignment; captions translate and bibliography is skipped while appendix resumes');
    if(process.env.PDF_QA_DIR) await figurePage.screenshot({path:path.join(path.resolve(process.env.PDF_QA_DIR),'title-caption.png')});
    const figureButton=figurePage.getByRole('button',{name:'翻译图片及图注',exact:true});
    await figureButton.waitFor();
    await figureButton.click();
    await figurePage.getByRole('button',{name:'重新识别',exact:true}).waitFor({timeout:30000});
    let imageBlock;
    for(let i=0;i<120;i++) {
      imageBlock=(await(await fetch(`${base}/api/documents/${doc.id}/blocks`)).json()).find(b=>b.page_number===4&&b.block_type==='image');
      if(imageBlock?.ocr?.status==='done') break;
      await delay(250);
    }
    assert(imageBlock.ocr.lines.some(l=>l.src.includes('Input')&&l.status==='translated'),JSON.stringify(imageBlock));
    assert.equal(imageBlock.ocr.captions.total,1);
    assert.equal(imageBlock.ocr.captions.translated,1);
    await figurePage.locator('button[title="图注已翻译 1/1"]').waitFor({timeout:15000});
    assert.equal(await figurePage.getByRole('button',{name:'重新识别',exact:true}).getAttribute('title'),'图注已翻译 1/1');
    assert.equal(await figurePage.getByText('图注已翻译 1/1',{exact:true}).count(),0,'successful caption status must not cover the figure');
    assert(imageBlock.ocr.lines.some(l=>l.src.includes('=')&&l.status==='preserved'&&l.dst===l.src));
    assert.equal(await figurePage.locator('[title*="x=2"]').count(),0,'formula must not be covered');
    await figurePage.locator('[title^="Input layer →"]').waitFor({timeout:15000});
    console.log('PASS actual local raster OCR translates labels and leaves formulas uncovered');

    await fetch(`${base}/api/settings`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({vision:{base_url:stubUrl,model:'offline-vision',api_key_env:'BROWSER_TEST_KEY'}})});
    const toggle=figurePage.getByRole('button',{name:'显示原文',exact:true});
    const buttonBox=await toggle.boundingBox();
    assert(buttonBox.height>=25 && buttonBox.height<=35,JSON.stringify(buttonBox));
    await toggle.click();
    assert.equal(await figurePage.locator('[title^="Input layer →"]').count(),0);
    await fetch(`${base}/api/settings`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({provider:'openai'})});
    await figurePage.getByRole('button',{name:'重新识别',exact:true}).click();
    const ocrRetry=page.getByRole('dialog',{name:'选择图片识别方式'});
    await ocrRetry.waitFor();
    assert(await ocrRetry.getByRole('radio',{name:'本地 OCR（默认）'}).isChecked());
    await ocrRetry.getByRole('button',{name:'开始识别'}).click();
    await figurePage.locator('[title="Input layer → 延迟后的中文译文"]').waitFor({timeout:30000});
    await figurePage.getByRole('button',{name:'重新识别',exact:true}).waitFor();
    await page.waitForFunction(async id=>(await(await fetch(`/api/documents/${id}`)).json()).status==='ready',doc.id);
    assert.equal(await figurePage.getByRole('button',{name:'显示原文',exact:true}).count(),1,'retranslation must reveal the new result after source-only mode');
    assert.equal(await figurePage.getByText('图注已翻译 1/1',{exact:true}).count(),0);
    await fetch(`${base}/api/settings`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({provider:'mock'})});
    console.log('PASS image retranslation reveals fresh delayed results after source-only mode without a caption success badge covering the image');
    await figurePage.getByRole('button',{name:'重新识别',exact:true}).click();
    const recognition=page.getByRole('dialog',{name:'选择图片识别方式'});
    await recognition.waitFor();
    assert(await recognition.getByRole('radio',{name:'本地 OCR（默认）'}).isChecked());
    await recognition.getByRole('radio',{name:'视觉模型：offline-vision'}).check();
    await recognition.getByRole('button',{name:'开始识别'}).click();
    const visionDialog=page.getByRole('dialog',{name:'区域识别与翻译',exact:true});
    await visionDialog.waitFor();
    await page.waitForFunction(()=>document.querySelector('[aria-label="区域译文"]')?.value.includes('视觉识别的输入层'));
    await visionDialog.getByRole('button',{name:'关闭',exact:true}).click();
    console.log('PASS bounded figure buttons toggle source; recognition defaults to OCR and configured vision processes the crop');

    await figurePage.getByRole('button',{name:'校对 / 视觉识别',exact:true}).click();
    const dialog=page.getByRole('dialog',{name:'区域识别与翻译',exact:true});
    await dialog.waitFor();
    assert((await dialog.locator('textarea').first().inputValue()).includes('Input'));
    await dialog.getByRole('button',{name:'本地重新识别',exact:true}).click();
    await dialog.locator('textarea').first().waitFor();
    await page.waitForFunction(()=>!document.querySelector('[role="dialog"][aria-label="区域识别与翻译"] textarea').disabled);
    assert((await dialog.locator('textarea').first().inputValue()).includes('Output'));
    await dialog.locator('textarea').first().fill('Corrected input label');
    await dialog.getByRole('button',{name:'翻译文本',exact:true}).click();
    await page.waitForFunction(()=>!document.querySelector('[role="dialog"][aria-label="区域识别与翻译"] textarea').disabled);
    assert((await dialog.getByLabel('区域译文').inputValue()).includes('Corrected input label'));
    const notesBefore=(await(await fetch(`${base}/api/documents/${doc.id}/notes`)).json()).length;
    const annotationsBefore=(await(await fetch(`${base}/api/documents/${doc.id}/annotations`)).json()).length;
    let annotationAttempts=0;
    const failOneAnnotation=async route=>{
      if(route.request().method()==='POST' && annotationAttempts++===0) await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({detail:'测试区域批注保存失败'})});
      else await route.continue();
    };
    await page.route(`**/api/documents/${doc.id}/annotations`,failOneAnnotation);
    await dialog.getByLabel('区域译文').fill('图中文字校对正文，第一次保存');
    await dialog.getByRole('button',{name:'保存到笔记与区域批注',exact:true}).click();
    await dialog.getByRole('alert').waitFor();
    await dialog.getByRole('button',{name:'保存到笔记与区域批注',exact:true}).click();
    await dialog.getByRole('button',{name:'已保存到笔记与批注',exact:true}).waitFor();
    await dialog.getByLabel('区域译文').fill('图中文字校对正文，修改后的内容');
    await dialog.getByRole('button',{name:'保存到笔记与区域批注',exact:true}).click();
    await dialog.getByRole('button',{name:'已保存到笔记与批注',exact:true}).waitFor();
    await page.unroute(`**/api/documents/${doc.id}/annotations`,failOneAnnotation);
    const imageNotes=await(await fetch(`${base}/api/documents/${doc.id}/notes`)).json();
    const imageAnnotations=await(await fetch(`${base}/api/documents/${doc.id}/annotations`)).json();
    assert.equal(imageNotes.length,notesBefore+1);assert.equal(imageAnnotations.length,annotationsBefore+1);
    assert(imageNotes.some(n=>n.content==='图中文字校对正文，修改后的内容' && n.quote==='Corrected input label'));
    await dialog.getByRole('button',{name:'关闭',exact:true}).click();
    const imagePdf=path.join(tmp,'image-notes.pdf');
    const pdfResponse=await fetch(`${base}/api/documents/${doc.id}/export-annotated.pdf`);
    if(!pdfResponse.ok) throw new Error(await pdfResponse.text());
    fs.writeFileSync(imagePdf,Buffer.from(await pdfResponse.arrayBuffer()));
    execFileSync(python,['-c',"import pymupdf,sys; p=pymupdf.open(sys.argv[1]); assert '图中文字校对正文' in ''.join(page.get_text() for page in list(p)[36:])",imagePdf],{windowsHide:true});
    console.log('PASS image correction, failed-save retry and repeated edit produce one note and annotation visible in exported PDF');

    // Rotated overlays must use visual coordinates and retain the text orientation.
    const rotated=path.join(tmp,'rotated.pdf');
    execFileSync(python,['-c','import pymupdf,sys; p=pymupdf.open(sys.argv[1]); p[0].set_rotation(90); p.save(sys.argv[2])',pdf,rotated],{windowsHide:true});
    await fetch(`${base}/api/settings`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({provider:'mock'})});
    const rotatedData=new FormData();rotatedData.append('file',new Blob([fs.readFileSync(rotated)],{type:'application/pdf'}),'rotated.pdf');
    const rd=await(await fetch(`${base}/api/documents`,{method:'POST',body:rotatedData})).json();
    for(let i=0;i<100;i++) {
      const d=await(await fetch(`${base}/api/documents/${rd.id}`)).json();
      if(d.status==='ready')break;
      await delay(100);
    }
    await fetch(`${base}/api/documents/${rd.id}/translate`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
    for(let i=0;i<100;i++) {
      const d=await(await fetch(`${base}/api/documents/${rd.id}`)).json();
      if(d.status==='ready'&&d.progress.translated>0)break;
      await delay(100);
    }
    await page.goto(`${base}/#/read/${rd.id}?page=1`);
    const overlay=page.locator('[data-pdf-page="1"] [title^="原文："]').first();
    await overlay.waitFor({state:'attached'});
    assert((await overlay.locator('div').first().getAttribute('style')).includes('rotate(90deg)'));
    const geometry=await overlay.evaluate(el=>{
      const a=el.getBoundingClientRect(), b=el.closest('[data-pdf-page]').getBoundingClientRect();
      return a.left>=b.left-3&&a.right<=b.right+3&&a.top>=b.top-3&&a.bottom<=b.bottom+3;
    });
    assert(geometry);
    assert.equal(errors.length,0,errors.join('\n'));
    console.log('PASS rotated page overlays align and rotate with the PDF');
    await page.goto(`${base}/#/`);
    const mirror=page.getByRole('button',{name:'切换标题墨滴效果',exact:true});
    await mirror.waitFor();
    await mirror.hover();
    assert.equal(await mirror.getAttribute('aria-pressed'),'true');
    await page.waitForFunction(()=>getComputedStyle(document.querySelector('.ink-top')).opacity==='1');
    await delay(2000);
    const titleBox=await mirror.boundingBox();
    await page.mouse.move(titleBox.x+titleBox.width*.8,titleBox.y+titleBox.height/2);
    await delay(500);
    assert(await page.locator('.ink-hero-title').evaluate(el=>{
      const base=[...el.querySelectorAll('.ink-base .ink-char')], top=[...el.querySelectorAll('.ink-top .ink-char')];
      return base.every((ch,i)=>{const a=ch.getBoundingClientRect(),b=top[i].getBoundingClientRect();return Math.abs(a.x-b.x)<.5&&Math.abs(a.y-b.y)<.5;});
    }),'gold and base glyphs must align');
    await page.locator('.ink-hero-title').evaluate(el=>{
      window.inkWrites=0;window.inkWatch=new MutationObserver(()=>window.inkWrites++);
      window.inkWatch.observe(el,{attributes:true,attributeFilter:['style']});
    });
    await delay(300);
    assert.equal(await page.evaluate(()=>window.inkWrites),0,'stationary ink must stop writing styles');
    await page.evaluate(()=>window.inkWatch.disconnect());
    if(process.env.PDF_QA_DIR)await page.screenshot({path:path.join(path.resolve(process.env.PDF_QA_DIR),'library-hover.png')});
    await page.mouse.move(0,0);
    assert.equal(await mirror.getAttribute('aria-pressed'),'false');
    const inkBefore=await page.locator('.library-ink').evaluate(el=>el.toDataURL());
    await page.waitForFunction(before=>document.querySelector('.library-ink').toDataURL()!==before,inkBefore);
    await mirror.focus();await page.keyboard.press('Enter');
    assert.equal(await mirror.getAttribute('aria-pressed'),'true');
    await page.getByLabel('文献排序').focus();
    assert.equal(await mirror.getAttribute('aria-pressed'),'false');
    await page.emulateMedia({reducedMotion:'reduce'});
    await mirror.hover();
    assert.equal(await page.locator('.ink-top').evaluate(el=>getComputedStyle(el).transitionDuration),'0s');
    const stillInk=await page.locator('.library-ink').evaluate(el=>el.toDataURL());
    await delay(150);
    assert.equal(await page.locator('.library-ink').evaluate(el=>el.toDataURL()),stillInk);
    await page.mouse.move(0,0);await page.emulateMedia({reducedMotion:'no-preference'});
    await page.getByRole('link',{name:'向下浏览文献书库',exact:true}).click();
    await page.waitForFunction(()=>window.scrollY>200);
    await delay(1000);
    assert(await page.locator('.library-section-heading').evaluate(el=>el.getBoundingClientRect().top>=document.querySelector('.library-header').getBoundingClientRect().bottom));
    const filter=page.getByLabel('筛选文件名或全文搜索');
    await filter.fill('definitely-no-match-xyz');
    assert.equal(await page.locator('.library-row').count(),0);
    await filter.fill('');
    await page.waitForFunction(()=>getComputedStyle(document.querySelector('.library-list')).opacity==='1');
    assert(await page.locator('.library-row').count()>0);
    const more=page.getByRole('button',{name:/更多操作：/}).first();
    await more.click();await page.getByRole('button',{name:'重新解析',exact:true}).waitFor();
    await page.keyboard.press('Escape');assert.equal(await more.getAttribute('aria-expanded'),'false');
    console.log('PASS ink layers align and settle; keyboard and reduced motion work; scroll cue and remounted filtered list remain visible');
    await page.getByRole('button',{name:'打开使用说明书',exact:true}).click();
    await page.waitForURL(/#\/read\/\d+/);
    const guideId=Number(page.url().match(/#\/read\/(\d+)/)[1]);
    let guideState;
    for(let i=0;i<100;i++) {
      guideState=await(await fetch(`${base}/api/documents/${guideId}`)).json();
      if(guideState.status==='ready' && guideState.page_count===4)break;
      await delay(100);
    }
    assert.equal(guideState.page_count,4);
    const duplicate=await(await fetch(`${base}/api/documents/sample`,{method:'POST'})).json();
    assert.equal(duplicate.id,guideId);
    const manual=await fetch(`${base}/api/documents/sample.pdf`);
    assert(manual.ok);assert.equal(manual.headers.get('content-type'),'application/pdf');
    assert(Buffer.from(await manual.arrayBuffer()).subarray(0,4).equals(Buffer.from('%PDF')));
    if(process.env.PUBLIC_SCREENSHOT_DIR) {
      const shots=path.resolve(process.env.PUBLIC_SCREENSHOT_DIR);
      assert(shots.startsWith(path.join(root,'docs')+path.sep),'public screenshots must stay in docs');
      fs.mkdirSync(shots,{recursive:true});
      const documents=await(await fetch(`${base}/api/documents`)).json();
      for(const d of documents) if(d.id!==guideId)await fetch(`${base}/api/documents/${d.id}`,{method:'DELETE'});
      execFileSync(python,[path.join(root,'scripts/seed_demo.py'),String(guideId)],{env,windowsHide:true});
      await page.setViewportSize({width:1440,height:960});
      await page.goto(`${base}/#/`);
      await page.getByRole('link',{name:'UserGuide.pdf',exact:true}).waitFor();
      await page.mouse.move(0,0);
      await delay(3000);
      await page.screenshot({path:path.join(shots,'hero.png')});
      await page.getByRole('link',{name:'向下浏览文献书库',exact:true}).click();
      await page.waitForFunction(()=>window.scrollY>200);
      await delay(1500);
      await page.screenshot({path:path.join(shots,'library.png')});
      await page.goto(`${base}/#/read/${guideId}?page=1`);
      await page.locator('[title="原文：Translator Reader User Guide"]').waitFor();
      await page.locator('[data-pdf-page="1"] canvas').first().waitFor();
      await delay(800);
      await page.screenshot({path:path.join(shots,'reader.png')});
      fs.copyFileSync(path.join(shots,'reader.png'),path.join(shots,'guide-translated.png'));
    }
    await page.goto(`${base}/#/`);
    await page.setViewportSize({width:390,height:844});
    await page.getByRole('button',{name:'打开使用说明书',exact:true}).waitFor();
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1));
    assert.equal(errors.length,0,errors.join('\n'));
    console.log('PASS built-in guide imports, deduplicates and downloads; library fits a phone viewport');
    const libraryData=await(await fetch(`${base}/api/documents`)).json();
    const touchContext=await browser.newContext({viewport:{width:390,height:844},hasTouch:true});
    const touchPage=await touchContext.newPage();
    await touchPage.route('**/api/documents',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(libraryData.slice(0,1).map(d=>({...d,filename:'A very long academic paper filename for responsive layout verification.pdf'})))}));
    await touchPage.goto(`${base}/#/`);
    const touchMirror=touchPage.getByRole('button',{name:'切换标题墨滴效果',exact:true});
    await touchMirror.tap();assert.equal(await touchMirror.getAttribute('aria-pressed'),'true');
    await touchMirror.tap();assert.equal(await touchMirror.getAttribute('aria-pressed'),'false');
    await touchPage.setViewportSize({width:320,height:844});
    assert(await touchPage.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
    await touchPage.getByRole('link',{name:'向下浏览文献书库',exact:true}).tap();
    await delay(1500);
    assert(await touchPage.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
    if(process.env.PDF_QA_DIR)await touchPage.screenshot({path:path.join(path.resolve(process.env.PDF_QA_DIR),'library-mobile.png')});
    await touchPage.unroute('**/api/documents');
    let imported=false;
    await touchPage.route('**/api/documents',route=>{
      if(route.request().method()==='POST') {
        imported=true;
        return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(libraryData[0])});
      }
      return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(imported?libraryData.slice(0,1):[])});
    });
    await touchPage.reload();await touchPage.getByRole('button',{name:/导入第一篇论文 PDF/}).waitFor();
    await touchPage.getByRole('link',{name:'向下浏览文献书库',exact:true}).tap();await delay(1500);
    if(process.env.PDF_QA_DIR)await touchPage.screenshot({path:path.join(path.resolve(process.env.PDF_QA_DIR),'library-empty.png')});
    await touchPage.locator('input[type="file"][accept="application/pdf"]').setInputFiles(pdf);
    await touchPage.waitForFunction(()=>document.querySelector('.library-row')&&getComputedStyle(document.querySelector('.library-list')).opacity==='1');
    assert.equal(await touchPage.locator('.library-row').count(),1);
    assert.equal(await touchPage.locator('.library-tools').evaluate(el=>getComputedStyle(el).opacity),'1');
    await touchContext.close();
    console.log('PASS first import reveals list and search controls');
    console.log('PASS touch toggles the mirror title; long filenames and empty library fit a 320px screen');
    let activeLists=0,maxActiveLists=0,listCalls=0;
    await page.route(`**/api/documents`,async route=>{
      if(route.request().method()!=='GET')return route.continue();
      activeLists++;maxActiveLists=Math.max(maxActiveLists,activeLists);listCalls++;
      await delay(listCalls===1?100:2200);
      activeLists--;
      await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(libraryData.map((d,i)=>i===0?{...d,status:'parsing'}:d))});
    });
    await page.reload();
    await delay(5600);
    assert(listCalls>=2);
    assert.equal(maxActiveLists,1,'slow library responses must not create overlapping polls');
    await page.unroute(`**/api/documents`);
    console.log('PASS library polling waits for slow responses instead of stacking requests');
  } catch(error) {
    console.error('Browser regression failed:',error);
    console.error('Backend log:',logs);
    throw error;
  } finally {
    if(browser) await browser.close();
    await new Promise(resolve=>stub.close(resolve));
    server.kill();
    await new Promise(resolve => { if(server.exitCode!==null) resolve(); else server.once('exit',resolve); });
    const target=fs.realpathSync(tmp);
    assert(target.toLowerCase().startsWith(path.join(root,'data').toLowerCase()+path.sep));
    try { execFileSync(python,['-c',
      'import pathlib,shutil,sys; p=pathlib.Path(sys.argv[1]).resolve(); root=pathlib.Path(sys.argv[2]).resolve(); assert p.parent==root and p.name.startswith("browser-regression-"); shutil.rmtree(p)',
      target,path.join(root,'data')],{windowsHide:true}); }
    catch(error) { console.error('Temporary directory cleanup failed:',error.message); }
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
