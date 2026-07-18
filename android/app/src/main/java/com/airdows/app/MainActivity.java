package com.airdows.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(AirDowsRuntimePlugin.class);
        registerPlugin(AirDowsTransferPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
