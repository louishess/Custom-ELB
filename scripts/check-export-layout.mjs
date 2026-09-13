import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const output=path.resolve(process.argv[2]||'artifacts/exports');
const browser=await chromium.launch({headless:true,executablePath:process.env.LABMATE_CHROMIUM || chromium.executablePath()});
const checks=[];
const requests=[];
try {
  const page=await browser.newPage({viewport:{width:1120,height:900}});
  page.on('request',request=>{if(/^https?:/.test(request.url()))requests.push(request.url());});
  for(const scope of ['entry','notebook']) {
    await page.goto(pathToFileURL(path.join(output,`${scope}.html`)).href);
    await page.locator('img').evaluateAll(images=>Promise.all(images.map(image=>image.decode())));
    await page.screenshot({path:path.join(output,`${scope}-screen.png`),fullPage:true});
    const geometry=await page.evaluate(()=>{
      const title=document.querySelector('.entry-title');
      return {background:getComputedStyle(document.body).backgroundColor,title:parseFloat(getComputedStyle(title).fontSize),body:parseFloat(getComputedStyle(document.body).fontSize),overflow:document.documentElement.scrollWidth>window.innerWidth,images:[...document.images].map(img=>({actual:img.width/img.height,source:img.naturalWidth/img.naturalHeight}))};
    });
    assert.equal(geometry.background,'rgb(255, 255, 255)');
    assert.equal(geometry.title/geometry.body,2);
    assert.equal(geometry.overflow,false);
    geometry.images.forEach(image=>assert.ok(Math.abs(image.actual-image.source)<0.01));
    for(const format of ['Letter','A4']) await page.pdf({path:path.join(output,`${scope}-${format}.pdf`),format,printBackground:true,displayHeaderFooter:false});
    await page.emulateMedia({media:'screen'});
    await page.setViewportSize({width:390,height:844});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth),false);
    await page.screenshot({path:path.join(output,`${scope}-narrow.png`),fullPage:true});
    await page.setViewportSize({width:1120,height:900});
    checks.push({scope,...geometry,letter:true,a4:true,narrow:true});
  }
  assert.deepEqual(requests,[]);
  await fs.writeFile(path.join(output,'layout-checks.json'),JSON.stringify({checks,externalRequests:requests},null,2)+'\n');
  console.log('PASS white styling, 2:1 title scale, image proportions, narrow layout, Letter/A4 printing, and zero external requests');
} finally {await browser.close();}
