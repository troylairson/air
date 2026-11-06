package com.overhead.tv;

import android.annotation.SuppressLint;
import android.graphics.Color;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.service.dreams.DreamService;
import android.view.Gravity;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.TextView;

/**
 * The Overhead map as the TV's screensaver (an Android "dream"): the same page as the app, map
 * only, at the address saved in the app. Any button on the remote ends it, like any screensaver.
 *
 * Google TV hides other apps' screensavers from its settings, so it's switched on once with adb:
 *   adb shell settings put secure screensaver_components com.overhead.tv/.OverheadDream
 */
public class OverheadDream extends DreamService {

    private static final long RETRY_MS = 30 * 1000; // try again this long after the box can't be reached

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable retry = this::load;
    private WebView web;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    public void onAttachedToWindow() {
        super.onAttachedToWindow();
        setInteractive(false); // a button press wakes the TV
        setFullscreen(true);
        setScreenBright(true);

        String address = MainActivity.savedAddress(this);
        if (address.isEmpty()) {
            TextView text = new TextView(this);
            text.setText("Open the Overhead app once and enter the box's address.");
            text.setTextColor(Color.rgb(238, 241, 245));
            text.setTextSize(24);
            text.setGravity(Gravity.CENTER);
            text.setBackgroundColor(Color.rgb(5, 8, 13));
            setContentView(text);
            return;
        }

        web = new WebView(this);
        web.setBackgroundColor(Color.rgb(5, 8, 13));
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                return false;
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (Build.VERSION.SDK_INT >= 23 && request.isForMainFrame()) retryLater();
            }

            @SuppressWarnings("deprecation")
            @Override
            public void onReceivedError(WebView view, int errorCode, String description, String failingUrl) {
                if (Build.VERSION.SDK_INT < 23) retryLater();
            }
        });
        setContentView(web);
    }

    private void load() {
        // screensaver=1: map only, without changing the app's own map-only setting
        if (web != null) web.loadUrl(MainActivity.pageUrl(MainActivity.savedAddress(this)) + "&screensaver=1");
    }

    private void retryLater() {
        handler.removeCallbacks(retry);
        handler.postDelayed(retry, RETRY_MS);
    }

    @Override
    public void onDreamingStarted() {
        super.onDreamingStarted();
        load();
    }

    @Override
    public void onDreamingStopped() {
        handler.removeCallbacks(retry);
        if (web != null) web.loadUrl("about:blank"); // stop fetching once the TV is in use again
        super.onDreamingStopped();
    }

    @Override
    public void onDetachedFromWindow() {
        handler.removeCallbacks(retry);
        if (web != null) {
            web.destroy();
            web = null;
        }
        super.onDetachedFromWindow();
    }
}
