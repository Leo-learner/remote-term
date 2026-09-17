// The settings sheet: font size, notifications, paired devices, lock and sign out, about.
import { currentSubscription, disablePush, enablePush, pushState } from './push.js';
import { h, relativeTime, toast } from './ui.js';

function section(title, ...rows) {
  return h('section', { class: 'settings-section' }, h('h3', {}, title), h('div', { class: 'settings-group' }, ...rows));
}

function row(label, ...controls) {
  return h('div', { class: 'settings-row' }, h('span', { class: 'settings-label' }, label), h('span', { class: 'settings-control' }, ...controls));
}

function toggle(checked, onchange) {
  return h('input', { type: 'checkbox', class: 'switch', checked, onchange: (event) => onchange(event.target.checked) });
}

// ctx: { connection, view, prefs, savePrefs, refit, onLock, onLogout, rerender }
export async function renderSettings(container, ctx) {
  const { connection, view } = ctx;
  const push = pushState();
  const [subscription, devices, pushPrefs] = await Promise.all([
    currentSubscription().catch(() => null),
    connection.request({ t: 'devices' }).catch(() => null),
    connection.request({ t: 'push-prefs' }).catch(() => null),
  ]);

  const fontValue = h('span', { class: 'value' }, `${view.fontSize} pt`);
  const setFont = (delta) => {
    view.fontSize = view.fontSize + delta;
    ctx.prefs.fontSize = view.fontSize;
    ctx.savePrefs();
    ctx.refit();
    fontValue.textContent = `${view.fontSize} pt`;
  };

  const appearance = section('外观',
    row('字号',
      h('button', { type: 'button', class: 'stepper', 'aria-label': '缩小', onclick: () => setFont(-1) }, '−'),
      fontValue,
      h('button', { type: 'button', class: 'stepper', 'aria-label': '放大', onclick: () => setFont(1) }, '+')));

  let notifications;
  if (!push.supported || !push.standalone) {
    notifications = section('通知', h('p', { class: 'settings-note' },
      push.standalone ? '这个浏览器不支持推送通知。' : '添加到主屏幕并从主屏幕打开后，才能开启通知：Safari 分享按钮 → 添加到主屏幕。'));
  } else if (push.permission === 'denied') {
    notifications = section('通知', h('p', { class: 'settings-note' }, '通知已被拒绝。到 iPhone 的「设置 → 通知」里找到这个 App 再打开。'));
  } else if (!subscription) {
    notifications = section('通知', row('推送通知', h('button', {
      type: 'button',
      class: 'pill',
      onclick: async () => {
        try {
          await enablePush(connection);
          toast('通知已开启');
        } catch (error) {
          toast(error.code === 'denied' ? '通知被拒绝了' : '没能开启通知');
        }
        ctx.rerender();
      },
    }, '开启')));
  } else {
    const prefs = pushPrefs?.prefs ?? {};
    const update = (patch) => connection.request({ t: 'push-prefs', prefs: patch }).catch(() => toast('没能保存'));
    notifications = section('通知',
      row(`命令跑完（≥${prefs.minSeconds ?? 30} 秒）`, toggle(prefs.commands !== false, (on) => update({ commands: on }))),
      row('终端响铃', toggle(prefs.bells !== false, (on) => update({ bells: on }))),
      row('程序通知（如 Claude Code）', toggle(prefs.programs !== false, (on) => update({ programs: on }))),
      row('测试', h('button', {
        type: 'button',
        class: 'pill',
        onclick: async () => {
          const reply = await connection.request({ t: 'push-test' }).catch(() => null);
          toast(reply?.sent ? '已发送，稍等几秒' : '发送失败');
        },
      }, '发送测试通知')),
      row('关闭通知', h('button', {
        type: 'button',
        class: 'pill secondary',
        onclick: async () => {
          await disablePush(connection);
          ctx.rerender();
        },
      }, '关闭')));
  }

  const deviceRows = (devices?.items ?? []).map((device) => row(
    h('span', {}, device.name, device.id === devices.current ? h('span', { class: 'badge' }, '本机') : null,
      h('small', {}, `配对于 ${relativeTime(device.createdAt)} · 最近使用 ${relativeTime(device.lastUsedAt)}`)),
    h('button', {
      type: 'button',
      class: 'pill secondary',
      onclick: async () => {
        const self = device.id === devices.current;
        const message = self ? '移除后这台设备需要重新扫码配对才能再用。' : '移除后那台设备就无法再登录。';
        if (!(await ctx.confirm({ title: `移除「${device.name}」？`, message, confirm: '移除', destructive: true }))) return;
        connection.send({ t: 'device-remove', id: device.id });
        setTimeout(ctx.rerender, 300);
      },
    }, '移除'),
  ));

  const pairing = h('div', { class: 'pairing', hidden: true });
  const devicesSection = section('设备',
    ...deviceRows,
    row('添加设备', h('button', {
      type: 'button',
      class: 'pill',
      onclick: async () => {
        try {
          const { url, expiresAt } = await connection.request({ t: 'pair-open' });
          pairing.hidden = false;
          pairing.replaceChildren(
            h('p', {}, `在另一台设备上打开下面的链接（${new Date(expiresAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} 前有效，只能用一次）：`),
            h('code', { class: 'pair-link' }, url),
            h('button', {
              type: 'button',
              class: 'pill',
              onclick: async () => {
                try {
                  await navigator.clipboard.writeText(url);
                  toast('已复制链接');
                } catch {
                  toast('复制失败');
                }
              },
            }, '复制链接'),
          );
        } catch {
          toast('电脑没有响应');
        }
      },
    }, '生成配对链接')),
    pairing);

  const security = section('安全',
    row('立即锁定', h('button', { type: 'button', class: 'pill secondary', onclick: ctx.onLock }, '锁定')),
    row('退出登录', h('button', { type: 'button', class: 'pill destructive', onclick: ctx.onLogout }, '退出')));

  const agent = connection.agent ?? {};
  const about = section('关于',
    row('电脑', h('span', { class: 'value' }, agent.host ?? '—')),
    row('往返延迟', h('span', { class: 'value' }, connection.rtt === null ? '—' : `${connection.rtt} ms`)),
    row('版本', h('span', { class: 'value' }, agent.version ?? '—')));

  container.replaceChildren(appearance, notifications, devicesSection, security, about);
}
