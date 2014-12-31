var express  = require('express'),
    request = require('request'),
    mustacheExpress = require('mustache-express'),
    bodyParser = require('body-parser'),
    app      = express(),
    radiodanClient = require('radiodan-client'),
    radiodan = radiodanClient.create(),
    player   = radiodan.player.get('main'),
    eventBus       = require('./lib/event-bus').create(),
    fs = require('fs'),
    path = require('path'),
    eventSource = require('express-eventsource'),
    port     = process.env.PORT || 5000;

// server things

app.engine('mustache', mustacheExpress());
app.set('view engine', 'mustache');
app.set('views', __dirname + '/static');

app.use(bodyParser.urlencoded({ extended: true }));

// initialise radiodan and listen for and emit events

app.use('/radiodan', radiodanClient.middleware({crossOrigin: true}));
bindToEventBus(player,eventBus);

// config things

var config = readConfig('config/config.json');
var currentFeedUrl = null;

console.log("config is");
console.log(config);

// server

// get rss allows you to set the rss file via the web 

app.get('/rss', function (req, res) {
  res.render('config', {});
});

// post rss sets the url, via the web only

app.post('/rss', function (req, res) {
  if (req.body && req.body.feedUrl) {
     addFeedURL(req.body.feedUrl, req,res);
  }
  res.redirect('/');
});

// rssFromNFC allows a post (e.g from NFC) to set the RSS feed url

app.post('/rssFromNFC', function (req, res) {
  stopPlaying();
  if (req.body && req.body.feedUrl) {

     showPowerLed([100,100,0]);
     addFeedURL(req.body.feedUrl);
  }

  res.redirect('/');
});


// stop playing (e.g. from NFC trigger)

app.post('/stopFromNFC', function (req, res) {
  var st = player;
  console.log("status %j", st);
  stopPlaying();
  showPowerLed([0,0,100]);
  res.redirect('/');
});


// "write" a card
// actually just adds a card id and url to a list
// screen 1: ask people to put the card in the box

app.get('/write', function (req, res) {
  res.render('write');
});


// screen 2: test the card for suitability and feed back information about it

app.get('/write2', function (req, res) {

  var msg = "";
  //load the file
  var fullPath = __dirname;
  var fullFile = path.join(fullPath,"config/uid.json");
  if ( fs.existsSync(fullFile) ) {
    var data = require(fullFile);
    if(data){
      var feedUrl = data["feedUrl"] | "";
      var uid = data["uid"] | "";
      if(uid == ""){
        msg = "No card available to read";
      }else if (feedUrl==""){
        msg = "Card "+uid+" ready to associate with a feed"
      }else if (feedUrl!=""){
        msg = "Card "+uid+" already exists in the database - currently linked to "+feedUrl+" - proceeding will link it to another feed";
      }else{
        msg = "Something went wrong";
      }
    }else{
       msg = "No data found in "+fullFile;
    }
  }else{
    msg = "No uid.json file found at "+fullFile;
  }
  res.render('write2', { feedUrl: req.body.feedUrl, msg: msg });

});

// screen 3: check the feed has enclosures

app.post('/write3', function (req, res) {
    request(req.body.feedUrl,function(err, data){
      var urlOk = "Contains audio links";
      if (err) {
        console.error('Error fetching feed');
        console.error(err.stack);
        urlOk = "problem with the feed url - check it doesn't have a typo - "+req.body.feedUrl;
        res.render('write3err', { feedUrl: req.body.feedUrl, urlOk: urlOk });
      }else{

        var urls = getMatches(data.body);

        if(urls!=null && urls.length>0){
           urlOk = "Found "+urls.length+" audio files in the RSS feed - all ok";
           res.render('write3', { feedUrl: req.body.feedUrl, urlOk: urlOk });
        }else{
          urlOk = "No playable audio files found in the RSS feed, though it does exist";
          res.render('write3err', { feedUrl: req.body.feedUrl, urlOk: urlOk });
        }
      }
    });
});


// screen 4: write the ID to the database and display results

app.post('/write4', function (req, res) {

  var feedUrl = req.body.feedUrl;

  // read the data file
  var fullPath = __dirname;
  var fullDataFile = path.join(fullPath,"config/data.json");
  var fullUidFile = path.join(fullPath,"config/uid.json");
  var uid_data = null;
  var data = null;
  var msg = "";

  if ( fs.existsSync(fullUidFile) ) {
    uid_data = require(fullUidFile);
  }else{
    console.log("no uid");
    msg = "can't complete - no uid found";
  }

  if ( fs.existsSync(fullDataFile) ) {
    data = require(fullDataFile);
  }else{
    msg = "no data file found - continuing";
    data = {};
  }
  if(uid_data && data){
   var uid = uid_data["uid"];
   if(data[uid]){
     msg = "Replaced "+data[uid]+" for "+uid+" with "+feedUrl;
   }else{
     msg = "New id "+uid+" contains "+feedUrl;
   }
   data[uid] = feedUrl;
   var j = JSON.stringify(data, null, 4)
   fs.writeFile(fullDataFile, j, function (err3) {
        if (err3) throw err3;
        console.log("saved");
   });

   addFeedURL(feedUrl);
  }else{
   console.log("all went wrong somewhere");
  } 
  res.render('write4', { feedUrl: feedUrl, cardId: uid, msg: msg });

});


// more server stuff

app.listen(port);

showPowerLed([0,0,200]);

// for reacting to button off / on

var powerButton = radiodan.button.get("power");
powerButton.on("press", stopPlaying);
powerButton.on("release", startPlaying);

process.on('SIGTERM', gracefulExit);
process.on('SIGINT' , gracefulExit);

app.use(express.static(__dirname + '/static'));

console.log('Listening on port '+port);

///-----------------///





///various handy methods

// turn the LED on with RGB arr

function showPowerLed(arr){
   var powerLED      = radiodan.RGBLED.get('power');
   powerLED.emit({
     emit: true,
     colour: arr,
   });
}


// start and stop playing

function startPlaying(){
  console.log("starting playing");
  player.play();
}

function stopPlaying() {
  console.log("stopping playing");
  player.pause({ value: true });
}


// main add feed url method

function addFeedURL(feedUrl){
  var bookmarked = config[feedUrl];
  currentFeedUrl = feedUrl;
  cacheRSSAndPlay(feedUrl,bookmarked);

}

// make a simple version of the RSS filename to use as a cache

function makeRSSName(feedUrl){

    var fn = feedUrl.replace(/^https?/,"");
    fn = fn.replace(/\W/g,"");
    return fn;
}


// complicated method, which
// * gets a feed url
// * compares it with any cached data from that feed url
// * plays what it finds using the following rules (thanks Richard):
// If there is a whole new one
//       play it
// else
//        play from where I stopped in whatever
// when that finishes play the next newer one (irrespective of listenedness)
// or if there is no newer one play the next older one.


function cacheRSSAndPlay(feedUrl, bookmarked){

  //make a simplified name from the feedUrl
  
  var fn = makeRSSName(feedUrl);
  console.log("caching feedurl "+feedUrl+" as "+fn);


  // get the feed data
  request(feedUrl,function(err, data){
    if (err){
       console.log("error in request for "+feedurl+" err "+err);
    }
    var fullPath = __dirname + "/cache";
    var fullFile = path.join(fullPath,fn);

    // check the cache
    console.log("Looking for cache "+fullFile);
    var exists = fs.existsSync(fullFile);
    console.log(exists +" exists");
    var new_urls = getMatches(data.body);
    var new_urls_str = new_urls.join("\n");

    if(exists){
     // compare old and new data

     fs.readFile(fullFile,'utf8', function (old_err, old_data) {
        console.log("hello "+fullFile);
        if (old_err) throw old_err;
        console.log(old_data);
        if(new_urls_str==old_data){
          console.log("data not changed");
          if(bookmarked){
            var bookmark = bookmarked["lastPlayed"];
            var toSeekTo = bookmarked["toSeekTo"] | 0;
            var bookmark_index = new_urls.indexOf(bookmark);
            if(bookmark_index==-1){
               //doesn't contain our cached one, so we put that on the front of the new list. THis shouldn't happen!
               var toPlay = new_urls.unshift(bookmark);
               playWithSeek(toPlay, toSeekTo);
            }else{
               //this is more likely - we are either at the start or somewhat through the  list, so we return it and everything after it   
               var toPlay = new_urls.slice(bookmark_index, new_urls.length);
               playWithSeek(toPlay, toSeekTo);
            }
          }else{
            //just return the new list, no starting point or seek exists
            playWithSeek(new_urls, 0);
          }

        }else{
          console.log("data changed, writing file "+fullFile);
          console.log(new_urls);
          writeFile(fullFile, new_urls_str);
          playWithSeek(new_urls, 0);
        }
      });      
    }else{
          console.log("no cache, data changed, writing file "+fullFile);
          writeFile(fullFile, new_urls_str);
          playWithSeek(new_urls, 0);
    }
  });

}


// Play a playlist (list of mp3s) and seek if we have a seek for the first one

function playWithSeek(playlist, seek){
  if(seek ==null || seek ==0){
          player.add({
                  playlist: playlist,
                  clear: true
          }).then(player.play());

  }else{
          player.add({
                  playlist: playlist,
                  clear: true
          }).then(player.play()).then(player.seek({"time":seek}));

  }

}

// hack-parse a feed for enclosures
// hack parsed because XML parsing is slow (sorry Andrew!)

function getMatches(str){
   console.log("getting matches");
   var results = [];
   var arrMatches = str.match(/<enclosure url=\"(.*?)\"/g);
   console.log(arrMatches);
   for(var a in arrMatches){
      var url_arr = arrMatches[a].match(/<enclosure url=\"(.*?)\"/);
      results.push(url_arr[1]);
   }
   return results;
}


// handle events, saving config where appropriate

function bindToEventBus(player, eventBus){

      player.on('player', function(playerData) {
        var msg = {
          playerId: player.id,
          player: playerData
        };

        eventBus.emit('player', msg);
      });

      player.on('playlist', function(playlistData) {
        var msg = {
          playerId: player.id,
          playlist: playlistData
        };

        eventBus.emit('playlist', msg);
      });

      var pl = null;

      ['*'].forEach(function (topic) {
        eventBus.on(topic, function (args) {
           if(args["playlist"] && args["playlist"].length>0){
             pl = args["playlist"][0];
             console.log("pl");
             console.log(pl);
             if(pl && pl.length > 0){
                writeConfig('config/playlist.json', playlist);               
             }
           }
           if(args["player"]){
             var ply = args["player"];
             console.log("ply");
             console.log(ply);
             var error = ply["error"];
             if(error){
                console.log("error in playback, skipping "+error);
                // not sure about this means of handling errors
                player.remove({"position":0});
                player.play();
             }
             var sid = ply["songid"];
             var elapsed = ply["elapsed"];
             var file = pl["file"];
             console.log("player "+file+" elapsed "+elapsed);
             if(file && elapsed){
               if(!config[currentFeedUrl]){
                  config[currentFeedUrl] = {};
               }
               config[currentFeedUrl]["lastPlayed"]=file;
               config[currentFeedUrl]["toSeekTo"]=elapsed;
               console.log("saving config");
               writeConfig('config/config.json', config);               
             }

           }

        });
      });

}


// read a json file

function readConfig(file) {
  console.log("path is "+file);
  console.log("fs exists "+fs.existsSync(file)+" process "+process.env.HOME);
  var fullPath = __dirname;
  var fullFile = path.join(fullPath,file);
  console.log(fs.existsSync(fullFile));
  if ( fs.existsSync(fullFile) ) {
    try{
      return require(fullFile);
    }catch(e){
      console.log("problem "+e);
      return {};
    }
  }else{
    console.log("No config file");
    return {};
  }
}

// write a json file

function writeConfig(file, config) {

  var fullPath = __dirname;
  var fullFile = path.join(fullPath,file);
  console.log("writing config path "+fullFile+" config "+JSON.stringify(config));
  writeFile(fullFile, JSON.stringify(config));
}

// write a string to file

function writeFile(fullFile, str){
    try{
      fs.writeFileSync(fullFile, str);
    }catch(e){
      console.log("problem saving file "+fullFile+" error: "+e);
    }

}

// exit

function gracefulExit() {
  console.log('Exiting...');
  player.clear().then(process.exit);
}

