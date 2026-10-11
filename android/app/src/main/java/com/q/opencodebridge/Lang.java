package com.q.opencodebridge;

import android.content.Context;
import android.content.SharedPreferences;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

/** App language: EN strings in code, RU table here. Single APK,
 *  switchable in Settings. Default follows the system locale. */
public final class Lang {
    private static Context app;
    private Lang() {}
    public static void init(Context c) { app = c.getApplicationContext(); }
    public static String cur() {
        if (app == null) return "en";
        String l = app.getSharedPreferences(BridgeService.PREFS, Context.MODE_PRIVATE).getString("lang", null);
        if (l == null) l = Locale.getDefault().getLanguage().startsWith("en") ? "en" : "ru";
        return l;
    }
    public static void setLang(Context c, String l) {
        c.getSharedPreferences(BridgeService.PREFS, Context.MODE_PRIVATE).edit().putString("lang", l).apply();
    }
    /** Look up an EN UI string in the current language. */
    public static String s(String en) {
        if ("en".equals(cur())) return en;
        String ru = RU.get(en);
        return ru != null ? ru : en;
    }
    private static final Map<String, String> RU = new HashMap<>();
    static {
        RU.put(" (tunnel)", " (туннель)");
        RU.put(" not found", " не найден");
        RU.put(" on network: ", "в сети: ");
        RU.put(" · sessions: ", " · сессий: ");
        RU.put("(the “certificate fingerprint” line)?\\n\\n", "(строка «Отпечаток сертификата»)?\\n\\n");
        RU.put(", ws proxy: ", ", ws-прокси: ");
        RU.put("Access revoked — open the app to pair", "Доступ отозван — откройте приложение для сопряжения");
        RU.put("Access revoked, switching to another computer…", "Доступ отозван, переключаюсь на другой компьютер…");
        RU.put("Add computer", "Добавить компьютер");
        RU.put("Allow", "Разрешить");
        RU.put("Always (2)", "Всегда (2)");
        RU.put("Always connected", "Всегда на связи");
        RU.put("Background connection", "Фоновая связь");
        RU.put("Background: WiFi only", "В фоне — только по WiFi");
        RU.put("Battery saver — will connect over WiFi in background", "Экономия батареи — в фоне подключусь по WiFi");
        RU.put("Battery saver — will connect when you open the app", "Экономия батареи — подключусь, когда откроете приложение");
        RU.put("Battery settings", "Настройки батареи");
        RU.put("Biometric or PIN unlock", "Вход по биометрии или PIN");
        RU.put("Bridge certificate fingerprint mismatch", "Отпечаток сертификата моста не совпадает");
        RU.put("Bridge error: HTTP ", "Ошибка моста: HTTP ");
        RU.put("Bridge found: ", "Мост найден: ");
        RU.put("Cancel", "Отмена");
        RU.put("Cancelled: fingerprint not confirmed", "Отменено: отпечаток не подтверждён");
        RU.put("Close", "Закрыть");
        RU.put("Computers", "Компьютеры");
        RU.put("Confirm it’s you", "Подтвердите, что это вы");
        RU.put("Connect with code", "Подключиться по коду");
        RU.put("Connected ", "Подключено ");
        RU.put("Connected (", "Подключено (");
        RU.put("Connection lost, reconnecting…", "Связь потеряна, переподключение…");
        RU.put("Connection status", "Состояние подключения");
        RU.put("Could not get the bridge certificate", "Не удалось получить сертификат моста");
        RU.put("Could not open battery settings", "Не удалось открыть настройки батареи");
        RU.put("Delete", "Удалить");
        RU.put("Delete “", "Удалить «");
        RU.put("Does it match what the PC terminal shows\\n", "Он совпадает с тем, что показан в терминале на ПК\\n");
        RU.put("Enter the code from the PC screen", "Введите код с экрана ПК");
        RU.put("Event", "Событие");
        RU.put("Failed: ", "Не удалось: ");
        RU.put("Found on network:", "Найдено в сети:");
        RU.put("If it does NOT match — the network may be intercepted, do not connect.", "Если НЕ совпадает — возможен перехват в сети, не подключайтесь.");
        RU.put("In battery-saving modes notifications arrive only while connected.", "В экономных режимах уведомления приходят только пока есть связь.");
        RU.put("Later", "Позже");
        RU.put("Looking for “", "Ищу «");
        RU.put("Matches", "Совпадает");
        RU.put("No", "Нет");
        RU.put("No (Esc)", "Нет (Esc)");
        RU.put("No camera access — enter the code from the PC screen manually", "Без доступа к камере — введите код с экрана ПК вручную");
        RU.put("No new computer found on the network — wait a couple of seconds or use QR", "Новый компьютер в сети не найден — подождите пару секунд или используйте QR");
        RU.put("No new computers visible on the network yet.", "Новых компьютеров в сети пока не видно.");
        RU.put("No p2p address for this PC: connect to it over WiFi,\\n", "Нет p2p-адреса этого ПК: подключитесь к нему по WiFi,\\n");
        RU.put("No paired computers.", "Нет сопряжённых компьютеров.");
        RU.put("Not an OpenCode Mobile QR code", "Это не QR-код OpenCode Mobile");
        RU.put("Not connected — searching…", "Нет подключения — идёт поиск…");
        RU.put("On the new PC run opencode-mobile --qr\\n", "На новом ПК выполните opencode-mobile --qr\\n");
        RU.put("Only while the app is open", "Только при открытом приложении");
        RU.put("OpenCode Mobile is locked", "OpenCode Mobile защищён");
        RU.put("PC not visible on WiFi — trying the internet (p2p)…", "ПК не виден в WiFi — пробую через интернет (p2p)…");
        RU.put("Pair with OpenCode Mobile", "Сопряжение с OpenCode Mobile");
        RU.put("Pairing on the PC itself stays (revoke via opencode-mobile --device).", "Сопряжение на самом ПК останется (отзыв — opencode-mobile --device).");
        RU.put("Pairing…", "Сопряжение…");
        RU.put("Point the camera at the QR code on the PC screen", "Наведите камеру на QR-код с экрана ПК");
        RU.put("Scan QR code", "Сканировать QR-код");
        RU.put("Searching for the bridge on the WiFi network…", "Поиск моста в WiFi-сети…");
        RU.put("Security", "Безопасность");
        RU.put("Set up a screen lock first (PIN or biometrics)", "Сначала настройте блокировку экрана (PIN или биометрию)");
        RU.put("Settings", "Настройки");
        RU.put("This computer’s certificate fingerprint:\\n\\n", "Отпечаток сертификата этого компьютера:\\n\\n");
        RU.put("To keep the bridge from dropping when the screen is off, ", "Чтобы мост не отваливался при погашенном экране, ");
        RU.put("UDP: bridge found ", "UDP: мост найден ");
        RU.put("UI: http://127.0.0.1:", "интерфейс: http://127.0.0.1:");
        RU.put("Unlock", "Разблокировать");
        RU.put("Verify the fingerprint", "Проверьте отпечаток");
        RU.put("Which computer to connect to?", "К какому компьютеру подключиться?");
        RU.put("Wrong code. Check the code in the PC terminal.", "Неверный код. Проверьте код в терминале ПК.");
        RU.put("Yes", "Да");
        RU.put("Yes (1)", "Да (1)");
        RU.put("\\nStart the bridge on your computer\\n(npm start in the bridge folder)\\nand scan the QR code from the terminal.\\n", "\\nЗапустите мост на компьютере\\n(npm start в папке bridge)\\nи отсканируйте QR-код из терминала.\\n");
        RU.put("\\nor enter the code from the PC screen:\\n", "\\nили введите код с экрана ПК:\\n");
        RU.put("after enabling internet access on it (opencode-mobile --device → i).", "включив на нём интернет-доступ (opencode-mobile --device → i).");
        RU.put("allow over the internet (p2p)", "разрешить через интернет (p2p)");
        RU.put("bridge", "мост");
        RU.put("code, e.g. A1B2C3", "код, например A1B2C3");
        RU.put("computer", "компьютер");
        RU.put("could not get the phone NodeId", "не удалось получить NodeId телефона");
        RU.put("could not start the local gateway", "не удалось поднять локальный шлюз");
        RU.put("could not start the tunnel", "не удалось запустить туннель");
        RU.put("e.g.: A1B2C3", "например: A1B2C3");
        RU.put("exempt OpenCode Mobile from battery optimization ", "снимите для OpenCode Mobile оптимизацию батареи ");
        RU.put("internet", "интернет");
        RU.put("internet, direct p2p", "интернет, p2p напрямую");
        RU.put("internet, via relay", "интернет, через relay");
        RU.put("mDNS: bridge found ", "mDNS: мост найден ");
        RU.put("no connection or entry", "нет соединения или записи");
        RU.put("not our QR", "не тот QR");
        RU.put("offline", "не в сети");
        RU.put("offline (last address: ", "не в сети (последний адрес: ");
        RU.put("on the next screen (otherwise Doze throttles the network and kills the tunnel).", "на следующем экране (Doze иначе душит сеть и убивает туннель).");
        RU.put("opencode events", "События opencode");
        RU.put("over WiFi (local network)", "по WiFi (локальная сеть)");
        RU.put("over the internet", "через интернет");
        RU.put("over the internet, direct p2p", "через интернет, p2p напрямую");
        RU.put("over the internet, relay", "через интернет, relay");
        RU.put("over the internet: direct p2p", "через интернет: p2p напрямую");
        RU.put("over the internet: relay server", "через интернет: relay-сервер");
        RU.put("phone p2p NodeId ready", "p2p NodeId телефона готов");
        RU.put("then scan the QR code or enter the code:", "и отсканируйте QR-код, либо введите код:");
        RU.put("tunnel unavailable: ", "туннель недоступен: ");
        RU.put("tunnel: ", "туннель: ");
        RU.put("with the screen off.", "при погашенном экране.");
        RU.put("Язык", "Language");
        RU.put("” from the app?\\n", "» из приложения?\\n");
        RU.put("⚠ Battery optimization is on — connection will drop ", "⚠ Оптимизация батареи активна — связь будет рваться ");
        RU.put("✓ Battery optimization off — background connection allowed.", "✓ Оптимизация батареи снята — фоновая связь разрешена.");
        RU.put("＋ Add computer", "＋ Добавить компьютер");
        RU.put("🖥 Computers…", "🖥 Компьютеры…");
    }
}
