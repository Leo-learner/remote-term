// A second look before sending a line that would cut this phone off from the Mac or take the Mac
// down, mirroring the rules the owner set for Orbit. It reads the line as typed, so aliases and
// scripts get past it: a seatbelt, not a lock.
const RULES = [
  [/\bnetworksetup\b.*-setairportpower\b.*\boff\b/i, '这条命令会关闭 Wi-Fi，电脑会断开连接，手机就连不上了'],
  [/\bifconfig\s+en\d+\s+down\b/i, '这条命令会关闭网卡，电脑会断开连接'],
  [/(^\s*|[;&|(]\s*)(sudo\s+(-\S+\s+)*)?(shutdown|halt|reboot)\b/i, '这条命令会关机或重启，之后没法远程开机'],
  [/\bpmset\b.*\bsleepnow\b/i, '这条命令会让电脑睡眠，之后没法远程唤醒'],
  [/\bosascript\b.*\b(shut down|restart|sleep)\b/i, '这条命令会关机、重启或让电脑睡眠'],
  [/\b(killall|pkill)\b.*clash/i, '这条命令会退出 Clash Verge'],
  [/\bquit\b.*\bclash/i, '这条命令会退出 Clash Verge'],
  [/\b(killall|pkill)\b.*\b(RemoteTerm|node)\b/i, '这条命令可能结束远程终端自己，手机会断开'],
  [/\blaunchctl\b.*\b(bootout|unload)\b/i, '这条命令会停止系统服务，远程终端可能断开'],
  [/\brm\s+(-\w+\s+)*-\w*[rR]\w*\s+(-\w+\s+)*(~|\$HOME|\/)\/?\s*$/, '这条命令会删除整个主目录或根目录'],
];

export function dangerReason(line) {
  for (const [pattern, reason] of RULES) if (pattern.test(line)) return reason;
  return null;
}
