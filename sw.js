"use strict";

const SHELL_CACHE = "simlsp-shell-v2";
const APP_SCOPE = self.registration.scope;
const APP_URL = new URL("./", APP_SCOPE).href;
const INDEX_URL = new URL("./index.html", APP_SCOPE).href;
const PRECACHE_URLS = [
  APP_URL,
  INDEX_URL,
  new URL("./manifest.webmanifest", APP_SCOPE).href,
  new URL("./icons/simlsp-192.png", APP_SCOPE).href,
  new URL("./icons/simlsp-512.png", APP_SCOPE).href,
  new URL("./icons/simlsp-192-maskable.png", APP_SCOPE).href,
  new URL("./icons/simlsp-512-maskable.png", APP_SCOPE).href,
  new URL("./icons/simlsp-refresh-tools.png", APP_SCOPE).href,
  new URL("./icons/simlsp-notification.png", APP_SCOPE).href,
  new URL("./icons/simlsp-notification-badge.png", APP_SCOPE).href
];

function inAppScope(value) {
  const scope = new URL(APP_SCOPE);
  const target = new URL(String(value || scope.href), scope.href);
  return target.origin === scope.origin && target.href.startsWith(scope.href) ? target : scope;
}

self.addEventListener("install", function (event) {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then(function (cache) { return cache.addAll(PRECACHE_URLS); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys()
      .then(function (names) {
        return Promise.all(names.filter(function (name) {
          return name.startsWith("simlsp-shell-") && name !== SHELL_CACHE;
        }).map(function (name) { return caches.delete(name); }));
      })
      .then(function () { return self.clients.claim(); })
  );
});

self.addEventListener("fetch", function (event) {
  const request = event.request;
  if (request.method !== "GET") return;

  const target = new URL(request.url);
  if (target.origin !== self.location.origin || !target.href.startsWith(APP_SCOPE)) return;

  if (request.mode === "navigate") {
    event.respondWith(fetch(request).then(function (response) {
      if (!response.ok) return response;
      return caches.open(SHELL_CACHE).then(function (cache) {
        return Promise.all([
          cache.put(APP_URL, response.clone()),
          cache.put(INDEX_URL, response.clone())
        ]).catch(function () {}).then(function () { return response; });
      });
    }).catch(function () {
      return caches.match(request)
        .then(function (cached) { return cached || caches.match(APP_URL); })
        .then(function (cached) { return cached || caches.match(INDEX_URL); });
    }));
    return;
  }

  event.respondWith(caches.match(request).then(function (cached) {
    if (cached) return cached;
    return fetch(request).then(function (response) {
      if (!response.ok) return response;
      return caches.open(SHELL_CACHE).then(function (cache) {
        return cache.put(request, response.clone()).catch(function () {}).then(function () { return response; });
      });
    });
  }));
});

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
  const icon = new URL("./icons/simlsp-notification.png", APP_SCOPE).href;
  const badge = new URL("./icons/simlsp-notification-badge.png", APP_SCOPE).href;

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
      if (clientUrl.origin === target.origin && clientUrl.href.startsWith(APP_SCOPE) && "focus" in client) {
        if ("navigate" in client && client.url !== target.href) client.navigate(target.href);
        return client.focus();
      }
    }
    return self.clients.openWindow(target.href);
  }));
});
