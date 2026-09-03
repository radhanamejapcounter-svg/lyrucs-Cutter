// In android/app/src/main/java/.../MainActivity.java
// (whatever package Capacitor generated for you)

import com.lyricscutter.ffmpeg.FfmpegCutterPlugin;   // add this import

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(FfmpegCutterPlugin.class);      // add this line BEFORE super.onCreate()
        super.onCreate(savedInstanceState);
    }
}
