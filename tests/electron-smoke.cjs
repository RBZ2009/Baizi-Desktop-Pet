/**
 * Responsibility: Exercise real Electron windows, IPC, utility-process SQLite and the packaged application.
 * Implementation: 1. Isolate user data. 2. Use a mock model. 3. Verify settings, chat, memory and session actions without paid services.
 */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const assert = require('node:assert/strict');
const root = process.env.BAIZI_SMOKE_APP_ROOT || path.resolve(__dirname, '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'baizi-ui-smoke-'));
app.setPath('userData', dataDir);
fs.writeFileSync(path.join(dataDir, 'pet-config.json'), JSON.stringify({ autoLaunch: false }));
const rendererErrors = [];
app.on('web-contents-created', (_event, contents) => {
  contents.on('console-message', event => {
    if (event.level >= 3) rendererErrors.push(event.message);
  });
});
const mock = http.createServer((req, res) => {
  let raw = '';
  req.on('data', chunk => raw += chunk);
  req.on('end', () => {
    const request = JSON.parse(raw);
    const extracting = request.messages[0]?.content.startsWith('从用户原话');
    const text = extracting ? '{"memories":[{"key":"名字","value":"小明","category":"profile"}]}' : '你好呀，小明。我会陪着你。';
    if (request.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
    } else res.end(JSON.stringify({ choices: [{ message: { content: text }, finish_reason: 'stop' }] }));
  });
});

// Bound every UI wait so a broken preload or gateway fails the smoke test clearly.
async function until(condition, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await condition();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw new Error('Timed out waiting for Electron UI.');
}

// Close only smoke-owned resources and leave the user's real application data intact.
async function finish(code) {
  app.emit('before-quit');
  mock.closeAllConnections(); mock.close();
  BrowserWindow.getAllWindows().forEach(window => window.destroy());
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* Child may still hold a temporary file until app quit. */ }
  app.exit(code);
}

app.whenReady().then(async () => {
  try {
    await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
    require(path.join(root, 'main.js'));
    const pet = await until(() => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html')));
    await until(() => pet.webContents.executeJavaScript('!!window.desktopPet'));
    const baseSize = pet.getSize();
    await pet.webContents.executeJavaScript(`document.getElementById('pet-container').dispatchEvent(new MouseEvent('click',{bubbles:true,clientX:40,clientY:12}))`);
    const chat = await until(() => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/chat.html')));
    await until(() => chat.webContents.executeJavaScript('!!window.desktopPet && !!document.getElementById("chat-input")'));
    await until(() => chat.isVisible());
    assert.deepEqual(pet.getSize(), baseSize);
    const basePetBounds = pet.getBounds();
    const initialChatBounds = chat.getBounds();
    assert.ok(Math.abs((basePetBounds.x + basePetBounds.width / 2) - (initialChatBounds.x + initialChatBounds.width / 2)) < 1);
    assert.ok(Math.abs(initialChatBounds.y - (basePetBounds.y + Math.round(basePetBounds.height * 0.61))) < 1);
    const initialInputHeight = await chat.webContents.executeJavaScript('document.getElementById("chat-input").getBoundingClientRect().height');
    assert.equal(await chat.webContents.executeJavaScript('!!document.getElementById("chat-send")'), false);
    await chat.webContents.executeJavaScript(`(() => { const input=document.getElementById('chat-input'); input.value='${'a'.repeat(500)}'; input.dispatchEvent(new Event('input',{bubbles:true})); })()`);
    await until(() => chat.webContents.executeJavaScript('document.getElementById("chat-input").getBoundingClientRect().height > 24'));
    const grownChatBounds = chat.getBounds();
    const grownInputHeight = await chat.webContents.executeJavaScript('document.getElementById("chat-input").getBoundingClientRect().height');
    assert.ok(grownInputHeight > initialInputHeight);
    assert.equal(grownChatBounds.y, initialChatBounds.y);
    assert.ok(Math.abs((basePetBounds.x + basePetBounds.width / 2) - (grownChatBounds.x + grownChatBounds.width / 2)) < 1);
    assert.deepEqual(pet.getSize(), baseSize);
    await chat.webContents.executeJavaScript('window.desktopPet.setChatPanelVisible(false)');
    await until(() => !chat.isVisible());
    await pet.webContents.executeJavaScript(`document.getElementById('pet-container').dispatchEvent(new MouseEvent('click',{bubbles:true,clientX:40,clientY:12}))`);
    await until(() => chat.isVisible());
    await pet.webContents.executeJavaScript('window.desktopPet.openDialogueSettings()');
    const panel = await until(() => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/ui/dialogue.html')));
    await until(() => panel.webContents.executeJavaScript('!!window.dialogue && !!document.getElementById("baseUrl").value'));
    const result = await panel.webContents.executeJavaScript(`window.dialogue.saveSettings({baseUrl:'http://127.0.0.1:${mock.address().port}/v1',model:'mock-model',apiKey:'smoke-test-key',autoMemory:true,ttsEnabled:false})`);
    assert.equal(result.hasApiKey, true);
    assert.equal(result.apiKey, undefined);
    const saved = fs.readFileSync(path.join(dataDir, 'gateway/settings.json'), 'utf8');
    assert.ok(!saved.includes('smoke-test-key'));
    await chat.webContents.executeJavaScript(`(() => { const input=document.getElementById('chat-input'); input.value='我叫小明'; input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})); })()`);
    await until(() => panel.webContents.executeJavaScript('window.dialogue.manage("history").then(result => result.messages.some(message=>message.role === "assistant" && message.status === "complete" && message.content.includes("你好呀")))'));
    await until(() => panel.webContents.executeJavaScript('window.dialogue.manage("memories").then(result => result.memories.some(memory => memory.value === "小明"))'));
    await panel.webContents.executeJavaScript('document.querySelector("[data-tab=memories]").click()');
    await until(() => panel.webContents.executeJavaScript('document.getElementById("memory-list").textContent.includes("小明")'));
    const memory = await panel.webContents.executeJavaScript('window.dialogue.manage("memories").then(result=>result.memories[0])');
    await panel.webContents.executeJavaScript(`window.dialogue.manage('saveMemory',{id:${JSON.stringify(memory.id)},value:'阿舟'})`);
    const changed = await panel.webContents.executeJavaScript('window.dialogue.manage("memories")');
    assert.equal(changed.memories[0].value, '阿舟');
    await panel.webContents.executeJavaScript(`window.dialogue.manage('deleteMemory',{id:${JSON.stringify(memory.id)}})`);
    assert.equal((await panel.webContents.executeJavaScript('window.dialogue.manage("memories")')).memories.length, 0);
    await panel.webContents.executeJavaScript('window.dialogue.manage("newSession")');
    const sessions = await panel.webContents.executeJavaScript('window.dialogue.manage("sessions")');
    assert.equal(sessions.sessions.length, 2);
    assert.equal((await panel.webContents.executeJavaScript('window.dialogue.manage("history")')).messages.length, 0);
    const exported = await panel.webContents.executeJavaScript('window.dialogue.manage("sessions")');
    assert.ok(exported.current);
    await panel.webContents.executeJavaScript('document.querySelector("[data-tab=history]").click()');
    await until(() => panel.webContents.executeJavaScript('document.getElementById("session-select").options.length === 2'));
    if (process.env.BAIZI_SMOKE_SCREENSHOT) fs.writeFileSync(process.env.BAIZI_SMOKE_SCREENSHOT, (await panel.webContents.capturePage()).toPNG());
    assert.deepEqual(rendererErrors.filter(message => !/WebGL|GPU|THREE|deprecated|allowances/.test(message)), []);
    console.log('Electron UI, encrypted settings, gateway chat, automatic memory, editing/deletion and sessions: PASS');
    await finish(0);
  } catch (error) { console.error(error); console.error(rendererErrors); await finish(1); }
});
