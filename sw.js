"use strict";

function inAppScope(value) {
  const scope = new URL(self.registration.scope);
  const target = new URL(String(value || scope.href), scope.href);
  return target.origin === scope.origin && target.href.startsWith(scope.href) ? target : scope;
}

self.addEventListener("push", function (event) {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (_) {
    data = { body: event.data ? event.data.text() : "Ada laporan baru yang perlu diperiksa." };
  }

  const title = String(data.title || "Laporan baru masuk").slice(0, 80);
  const body = String(data.body || "Ada laporan baru yang perlu diperiksa.").slice(0, 180);
  const target = inAppScope(data.url);
  const icon = new URL("./icons/simlsp-notification.png", self.registration.scope).href;
  const badge = new URL("./icons/simlsp-notification-badge.png", self.registration.scope).href;

  event.waitUntil(self.registration.showNotification(title, {
    body: body,
    icon: icon,
    badge: badge,
    tag: String(data.tag || "simlsp-laporan-baru"),
    renotify: true,
    data: { url: target.href }
  }));
});

self.addEventListener("notificationclick", function (event) {
  event.notification.close();
  const target = inAppScope(event.notification.data && event.notification.data.url);
  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (windows) {
    for (const client of windows) {
      const clientUrl = new URL(client.url);
      if (clientUrl.origin === target.origin && clientUrl.href.startsWith(self.registration.scope) && "focus" in client) {
        if ("navigate" in client && client.url !== target.href) client.navigate(target.href);
        return client.focus();
      }
    }
    return self.clients.openWindow(target.href);
  }));
});
