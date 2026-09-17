// Web Push: iOS allows it only for the home screen app, and only after a tap asked for permission.
// The subscription goes to the Mac over the encrypted channel; the Mac sends pushes itself.
import { fromB64u, toB64u } from '/shared/bytes.js';

export function pushState() {
  const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  return { supported, standalone, permission: supported ? Notification.permission : 'unsupported' };
}

export function registerWorker() {
  if (!('serviceWorker' in navigator)) return Promise.resolve(null);
  return navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => null);
}

export async function currentSubscription() {
  if (!('serviceWorker' in navigator)) return null;
  const registration = await navigator.serviceWorker.getRegistration('/');
  return registration ? registration.pushManager.getSubscription() : null;
}

// Must be called straight from a tap: the permission prompt needs the user's gesture.
export async function enablePush(connection) {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw Object.assign(new Error(permission), { code: permission });
  const registration = await navigator.serviceWorker.ready;
  const { key } = await connection.request({ t: 'push-key' });
  let subscription = await registration.pushManager.getSubscription();
  const current = subscription?.options?.applicationServerKey;
  if (subscription && current && toB64u(current) !== key) {
    await subscription.unsubscribe(); // made for another Mac key; start over
    subscription = null;
  }
  subscription ??= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: fromB64u(key) });
  return connection.request({ t: 'push-subscribe', subscription: subscription.toJSON() });
}

export async function disablePush(connection) {
  const subscription = await currentSubscription();
  if (!subscription) return;
  await connection.request({ t: 'push-unsubscribe', endpoint: subscription.endpoint }).catch(() => {});
  await subscription.unsubscribe();
}
