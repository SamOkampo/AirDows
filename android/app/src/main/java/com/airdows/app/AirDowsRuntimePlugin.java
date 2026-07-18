package com.airdows.app;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.PluginMethod;

@CapacitorPlugin(name = "AirDowsRuntime")
public class AirDowsRuntimePlugin extends Plugin {
    @PluginMethod
    public void getConfig(PluginCall call) {
        String signalingUrl = getConfig().getString("signalingUrl", "");
        JSObject result = new JSObject();
        result.put("signalingUrl", signalingUrl);
        call.resolve(result);
    }
}
