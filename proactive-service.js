/**
 * Responsibility: Schedule low-frequency, user-visible companion reminders.
 * Implementation: 1. Respect pause, quiet hours and active conversations. 2. Use bounded templates.
 * 3. Emit only to the main renderer so messages follow the normal speech bubble path.
 */
class ProactiveService {
  constructor({ intervalMinutes = 120, getIntervalMinutes = null, isEnabled = () => true, isPaused = () => false, isBusy = () => false, emit = () => {} } = {}) {
    this.intervalMinutes = intervalMinutes; this.getIntervalMinutes = getIntervalMinutes; this.isEnabled = isEnabled; this.isPaused = isPaused; this.isBusy = isBusy; this.emit = emit; this.timer = null; this.last = 0;
  }
  interval() { return Math.max(30, Number(this.getIntervalMinutes?.() || this.intervalMinutes) || 120); }
  start() { this.stop(); this.timer = setInterval(() => this.tick(), this.interval() * 60000); }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }
  tick(now = Date.now()) {
    if (!this.isEnabled() || this.isPaused() || this.isBusy() || now - this.last < this.interval() * 60000) return false;
    const hour = new Date(now).getHours();
    if (hour < 9 || hour >= 23) return false;
    this.last = now;
    const messages = ['起来活动一下吧。喝口水，再继续。', '已经专注一会儿了，要不要看看窗外？', '我还在这里。先眨眨眼，再做下一件事。'];
    this.emit({ text: messages[Math.floor(Math.random() * messages.length)], source: 'proactive' });
    return true;
  }
}
module.exports = { ProactiveService };
