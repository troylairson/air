package com.overhead.tv;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.text.InputType;
import android.view.KeyEvent;
import android.view.View;
import android.view.WindowManager;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;

/**
 * The Overhead display on Android TV: the page the box serves (http://<box>:8090), full screen,
 * in TV mode (?mode=tv). All the flight logic stays on the box; this only shows the page, keeps
 * the screen on and turns the remote's buttons into the page's commands (window.overheadCommand).
 *
 * Remote: arrows pan, OK picks the next plane, channel up/down or fast-forward/rewind zoom,
 * Menu toggles map-only, Back undoes (unpick, then back to the home view) and then exits.
 * Hold Back to change the box's address.
 */
public class MainActivity extends Activity {

    private static final String PREFS = "overhead";
    private static final String KEY_ADDRESS = "address";

    private WebView web;
    private SharedPreferences prefs;
    private boolean backLongPressed;
    private AlertDialog dialog;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        prefs = getSharedPreferences(PREFS, MODE_PRIVATE);

        web = new WebView(this);
        web.setBackgroundColor(Color.rgb(5, 8, 13)); // the page's background, so loading isn't a white flash
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true); // the page remembers the map-only choice in localStorage
        settings.setMediaPlaybackRequiresUserGesture(true);
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                return false; // stay inside the app
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (Build.VERSION.SDK_INT >= 23 && request.isForMainFrame()) {
                    showError(error.getDescription().toString());
                }
            }

            @SuppressWarnings("deprecation")
            @Override
            public void onReceivedError(WebView view, int errorCode, String description, String failingUrl) {
                if (Build.VERSION.SDK_INT < 23) showError(description);
            }
        });
        setContentView(web);
        hideSystemBars();

        if (address().isEmpty()) askAddress(false);
        else load();
    }

    private String address() {
        return prefs.getString(KEY_ADDRESS, "");
    }

    /** "192.168.1.50:8090" -> "http://192.168.1.50:8090/?mode=tv" */
    private String pageUrl() {
        String base = address().trim();
        if (!base.startsWith("http://") && !base.startsWith("https://")) base = "http://" + base;
        while (base.endsWith("/")) base = base.substring(0, base.length() - 1);
        return base + "/?mode=tv";
    }

    private void load() {
        web.loadUrl(pageUrl());
    }

    private void askAddress(boolean cancelable) {
        if (dialog != null && dialog.isShowing()) return;
        final EditText input = new EditText(this);
        input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        input.setSingleLine(true);
        input.setHint("192.168.1.50:8090");
        input.setText(address());
        input.setSelection(input.getText().length());
        AlertDialog.Builder builder = new AlertDialog.Builder(this)
                .setTitle("Overhead display address")
                .setMessage("The ZimaOS box's address and the display port, e.g. 192.168.1.50:8090")
                .setView(input)
                .setCancelable(cancelable)
                .setPositiveButton("Save", (d, which) -> {
                    String value = input.getText().toString().trim();
                    if (value.isEmpty()) {
                        askAddress(cancelable);
                        return;
                    }
                    prefs.edit().putString(KEY_ADDRESS, value).apply();
                    load();
                });
        if (cancelable) builder.setNegativeButton("Cancel", null);
        dialog = builder.show();
    }

    private void showError(String what) {
        if (dialog != null && dialog.isShowing()) return;
        dialog = new AlertDialog.Builder(this)
                .setTitle("Can't reach the display")
                .setMessage(pageUrl() + "\n\n" + what + "\n\nIs the box on, and is the address right?")
                .setCancelable(false)
                .setPositiveButton("Retry", (d, which) -> load())
                .setNegativeButton("Change address", (d, which) -> askAddress(false))
                .show();
    }

    /** Sends a command to the page; onResult gets "true" if the page used it. */
    private void command(String name, android.webkit.ValueCallback<String> onResult) {
        web.evaluateJavascript(
                "window.overheadCommand ? String(window.overheadCommand('" + name + "')) : 'false'",
                onResult);
    }

    private static String commandFor(int keyCode) {
        switch (keyCode) {
            case KeyEvent.KEYCODE_DPAD_UP: return "panUp";
            case KeyEvent.KEYCODE_DPAD_DOWN: return "panDown";
            case KeyEvent.KEYCODE_DPAD_LEFT: return "panLeft";
            case KeyEvent.KEYCODE_DPAD_RIGHT: return "panRight";
            case KeyEvent.KEYCODE_DPAD_CENTER:
            case KeyEvent.KEYCODE_ENTER:
            case KeyEvent.KEYCODE_NUMPAD_ENTER:
            case KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE:
                return "nextPlane";
            case KeyEvent.KEYCODE_CHANNEL_UP:
            case KeyEvent.KEYCODE_PAGE_UP:
            case KeyEvent.KEYCODE_MEDIA_FAST_FORWARD:
            case KeyEvent.KEYCODE_PLUS:
            case KeyEvent.KEYCODE_ZOOM_IN:
                return "zoomIn";
            case KeyEvent.KEYCODE_CHANNEL_DOWN:
            case KeyEvent.KEYCODE_PAGE_DOWN:
            case KeyEvent.KEYCODE_MEDIA_REWIND:
            case KeyEvent.KEYCODE_MINUS:
            case KeyEvent.KEYCODE_ZOOM_OUT:
                return "zoomOut";
            case KeyEvent.KEYCODE_MENU:
            case KeyEvent.KEYCODE_PROG_RED:
            case KeyEvent.KEYCODE_INFO:
            case KeyEvent.KEYCODE_GUIDE:
                return "toggleCards";
            default:
                return null;
        }
    }

    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        if (dialog != null && dialog.isShowing()) return super.dispatchKeyEvent(event);
        int code = event.getKeyCode();

        // Back: a short press undoes (or exits); holding it opens the address setting.
        if (code == KeyEvent.KEYCODE_BACK) {
            if (event.getAction() == KeyEvent.ACTION_DOWN) {
                if (event.getRepeatCount() == 0) backLongPressed = false;
                else if (!backLongPressed && event.getRepeatCount() >= 15) { // held about a second
                    backLongPressed = true;
                    askAddress(true);
                }
            } else if (event.getAction() == KeyEvent.ACTION_UP && !backLongPressed) {
                command("back", result -> {
                    if (!"\"true\"".equals(result) && !"true".equals(result)) finish();
                });
            }
            return true;
        }

        String name = commandFor(code);
        if (name == null) return super.dispatchKeyEvent(event);
        if (event.getAction() == KeyEvent.ACTION_DOWN) {
            // holding an arrow or zoom key repeats; OK and Menu act once per press
            boolean repeats = !name.equals("nextPlane") && !name.equals("toggleCards");
            if (event.getRepeatCount() == 0 || repeats) command(name, null);
        }
        return true;
    }

    @SuppressWarnings("deprecation")
    private void hideSystemBars() {
        web.setSystemUiVisibility(View.SYSTEM_UI_FLAG_FULLSCREEN
                | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_LAYOUT_STABLE);
    }

    @Override
    protected void onResume() {
        super.onResume();
        web.onResume();
        web.resumeTimers();
        hideSystemBars();
    }

    @Override
    protected void onPause() {
        web.onPause();
        web.pauseTimers(); // stop fetching while another app is on screen
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        if (dialog != null) dialog.dismiss();
        web.destroy();
        super.onDestroy();
    }
}
