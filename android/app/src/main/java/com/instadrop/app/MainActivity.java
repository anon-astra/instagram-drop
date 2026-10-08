package com.instadrop.app;

import android.app.*;
import android.os.*;
import android.content.*;
import android.graphics.Color;
import android.provider.MediaStore;
import android.content.ContentValues;
import android.net.Uri;
import android.view.*;
import android.widget.*;
import org.json.*;
import java.net.*;
import java.io.*;
import java.util.concurrent.*;

public class MainActivity extends Activity {
  static final String API="https://drop-public-media.anon69f.chatgpt.site/api/resolve";
  final ExecutorService pool=Executors.newSingleThreadExecutor();
  EditText link,session;
  TextView status;
  Button download;
  String shared="";
  int background=0xff000000;
  void message(String s){runOnUiThread(()->status.setText(s));}
  @Override public void onCreate(Bundle b){
    super.onCreate(b);
    getWindow().setStatusBarColor(Color.BLACK);getWindow().setNavigationBarColor(Color.BLACK);
    LinearLayout root=new LinearLayout(this);root.setOrientation(1);root.setPadding(36,50,36,24);root.setBackgroundColor(background);
    TextView title=new TextView(this);title.setText("DROP  •");title.setTextSize(30);title.setTextColor(Color.WHITE);root.addView(title);
    TextView intro=new TextView(this);intro.setText("SHARE AN INSTAGRAM LINK TO DOWNLOAD");intro.setTextColor(0xffaaaaaa);intro.setPadding(0,24,0,20);root.addView(intro);
    link=new EditText(this);link.setSingleLine(false);link.setMinLines(2);link.setHint("Instagram post / Reel URL");link.setTextColor(Color.WHITE);link.setHintTextColor(0xff888888);root.addView(link);
    session=new EditText(this);session.setSingleLine(true);session.setHint("Instagram sessionid (required by existing resolver)");session.setInputType(129);session.setTextColor(Color.WHITE);session.setHintTextColor(0xff888888);
    session.setText(getPreferences(0).getString("session",""));root.addView(session);
    download=new Button(this);download.setText("DOWNLOAD TO GALLERY");root.addView(download);
    status=new TextView(this);status.setTextColor(Color.LTGRAY);status.setText("Ready. Share a link from Instagram or paste it here.");status.setPadding(0,20,0,0);root.addView(status);
    setContentView(root);
    download.setOnClickListener(v->start());
    receive(getIntent());
  }
  @Override protected void onNewIntent(Intent i){super.onNewIntent(i);setIntent(i);receive(i);}
  void receive(Intent i){
    if(Intent.ACTION_SEND.equals(i.getAction()) && "text/plain".equals(i.getType())){
      String s=i.getStringExtra(Intent.EXTRA_TEXT);
      if(s!=null){link.setText(s);if(!session.getText().toString().trim().isEmpty())start();}
    }
  }
  String canonical(String text) throws Exception {
    java.util.regex.Matcher m=java.util.regex.Pattern.compile("https?://(?:www\\.)?instagram\\.com/(?:p|reel|tv)/[A-Za-z0-9_-]+",java.util.regex.Pattern.CASE_INSENSITIVE).matcher(text);
    if(!m.find())throw new Exception("Invalid Instagram post or Reel URL");
    return m.group();
  }
  void start(){
    String url=link.getText().toString(), sid=session.getText().toString().trim();
    if(sid.isEmpty()){message("Enter your Instagram sessionid once, then download.");return;}
    getPreferences(0).edit().putString("session",sid).apply();
    download.setEnabled(false);message("Resolving media…");
    pool.execute(()->{
      try{
        JSONObject body=new JSONObject();body.put("url",canonical(url));body.put("sessionId",sid);body.put("highResolution",true);
        HttpURLConnection c=(HttpURLConnection)new URL(API).openConnection();c.setRequestMethod("POST");c.setConnectTimeout(20000);c.setReadTimeout(60000);c.setDoOutput(true);c.setRequestProperty("Content-Type","application/json");
        try(OutputStream o=c.getOutputStream()){o.write(body.toString().getBytes("UTF-8"));}
        int code=c.getResponseCode();InputStream stream=code<400?c.getInputStream():c.getErrorStream();
        ByteArrayOutputStream buffer=new ByteArrayOutputStream();byte[] tmp=new byte[8192];int n;while((n=stream.read(tmp))!=-1)buffer.write(tmp,0,n);
        JSONObject response=new JSONObject(buffer.toString("UTF-8"));c.disconnect();
        if(code>=400)throw new Exception(response.optString("error","Resolver error "+code));
        JSONArray items=response.getJSONArray("items");if(items.length()==0)throw new Exception("No downloadable media found.");
        for(int j=0;j<items.length();j++){
          JSONObject item=items.getJSONObject(j);String type=item.optString("type");boolean video=type.equals("video");
          message("Downloading "+(j+1)+" / "+items.length()+"…");
          save(item.getString("url"),video,j);
        }
        message("Saved "+items.length()+" item(s) to Pictures/Insta Drop.");
      }catch(Exception e){message("Download failed: "+e.getMessage());}
      finally{runOnUiThread(()->download.setEnabled(true));}
    });
  }
  void save(String url,boolean video,int index)throws Exception{
    HttpURLConnection c=(HttpURLConnection)new URL(url).openConnection();c.setConnectTimeout(20000);c.setReadTimeout(120000);c.setRequestProperty("User-Agent","Mozilla/5.0");if(c.getResponseCode()>=400)throw new IOException("Media HTTP "+c.getResponseCode());
    ContentValues v=new ContentValues();v.put(MediaStore.MediaColumns.DISPLAY_NAME,"DROP_"+System.currentTimeMillis()+"_"+index+(video?".mp4":".jpg"));
    v.put(MediaStore.MediaColumns.MIME_TYPE,video?"video/mp4":"image/jpeg");
    v.put(MediaStore.MediaColumns.RELATIVE_PATH,(video?"Movies":"Pictures")+"/Insta Drop");
    v.put(MediaStore.MediaColumns.IS_PENDING,1);
    Uri dest=getContentResolver().insert(video?MediaStore.Video.Media.EXTERNAL_CONTENT_URI:MediaStore.Images.Media.EXTERNAL_CONTENT_URI,v);
    if(dest==null)throw new IOException("Could not create gallery item");
    try(InputStream in=c.getInputStream();OutputStream out=getContentResolver().openOutputStream(dest)){
      byte[] bytes=new byte[32768];int n;while((n=in.read(bytes))!=-1)out.write(bytes,0,n);
      v.clear();v.put(MediaStore.MediaColumns.IS_PENDING,0);getContentResolver().update(dest,v,null,null);
    }catch(Exception e){getContentResolver().delete(dest,null,null);throw e;}finally{c.disconnect();}
  }
}
