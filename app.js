/**
 * Module dependencies.
 */

'use strict';

const {createHash} = require('crypto');
const path = require('path');
const url = require('url');

const express = require('express');
const bodyParser = require('body-parser');
const cookieParser = require('cookie-parser');
const favicon = require('serve-favicon');
const logger = require('morgan');
const HTMLGen = require('html5-gen');
const _ = require('underscore');
const debug = require('debug')('jsernews:app');

const {keyboardNavigation, latestNewsPerPage, passwordMinLength, savedNewsPerPage, siteName, siteDescription, siteUrl, usernameRegexp} = require('./config');
const {authUser, checkUserCredentials, createUser, getUserByUsername, incrementKarmaIfNeeded, isAdmin, updateAuthToken} = require('./user');
const {computeNewsRank, computeNewsScore, getLatestNews, getTopNews, getNewsById, getNewsDomain, getNewsText, getPostedNews, getSavedNews, newsToHTML, newsListToHTML} = require('./news');
const {checkParams, strElapsed} = require('./utils');
const redis = require('./redis');
const version = require('./package').version;

const app = express();

// uncomment after placing your favicon in /public
app.use(favicon(path.join(__dirname, 'public', 'favicon.ico')));
app.use(logger('dev'));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

let $h, $user, $r = redis;

// before do block
app.use(async (req, res, next) => {

  $user = global.$user = await authUser(req.cookies.auth);
  if ($user) await incrementKarmaIfNeeded();

  $h = global.$h = new HTMLGen();
  $h.append(() => {
    return $h.link({href: '/css/style.css?v0.0.1', rel: 'stylesheet'}) +
      $h.link({href: '/favicon.ico', rel: 'shortcut icon'});
  });
  $h.append(applicationHeader(), 'header');
  $h.append(applicationFooter, 'footer');
  $h.append(() => {
    return $h.script({src: '//code.jquery.com/jquery-3.1.1.min.js'}) +
      $h.script({src: '/js/app.js?v0.0.1'}) +
      ($user ? $h.script(`var apisecret = '${$user.apisecret}';`) : '') +
      (keyboardNavigation == 1 
        ? $h.script('setKeyboardNavigation();') : '');
  }, 'body');

  next();
});

app.get('/', async (req, res) => {
  let [news, numitems] = await getTopNews();
  $h.setTitle(`${siteName} - ${siteDescription}`);
  res.send($h.page($h.h2('Top News') + newsListToHTML(news, req.query)));
});

app.get('/latest', (req, res) => {
  res.redirect('/latest/0');
});

app.get('/latest/:start', async (req, res) => {
  let {start} = req.params;
  $h.setTitle(`Latest News - ${siteName}`);
  let paginate = {
    get: async (start, count) => {
      return await getLatestNews(start, count);
    },
    render: (item) => {
      return newsToHTML(item);
    },
    start: start,
    perpage: latestNewsPerPage,
    link: '/latest/$'
  }
  let newslist = await listItems(paginate);
  res.send($h.page(() => {
    return $h.h2('Latest News') +
      $h.section({id: 'newslist'}, newslist);
  }));
});

app.get('/random', async (req, res) => {
  let counter = await $r.get('news.count');
  let random = 1 + _.random(parseInt(counter));

  res.redirect(await $r.exists(`news:${random}`) ? `/news/${random}` : `/news/${counter}`);
});

app.get('/news/:news_id', async (req, res, next) => {
  let {news_id} = req.params;
  let news = await getNewsById(parseInt(news_id));
  if (!news || !news.id) {
    let err = new Error('404 - This news does not exist.');
    err.status = 404;
    return next(err);
  }

  // Show the news text if it is a news without URL.
  let user, top_comment;
  if (!getNewsDomain(news) && !news.del) {
    let c = {
        body: getNewsText(news),
        ctime: news.ctime,
        user_id: news.user_id,
        thread_id: news.id,
        topcomment: true
    }
    // user = get_user_by_id(news["user_id"]) || DeletedUser
    // top_comment = $h.topcomment {comment_to_html(c,user)}
  } else {
    top_comment = "";
  }

  $h.setTitle(`${news.title} - ${siteName}`);
  let script = $h.script('$(function() {$("input[name=post_comment]").click(post_comment);});');
  $h.append(script, 'body');
  let html = $h.page(() => {
    return $h.section({id: 'newslist'}, newsToHTML(news)) + top_comment +
      ($user && !news.del ?
        $h.form({name: 'f'}, () => {
          return $h.hidden({name: 'news_id', value: news.id}) +
            $h.hidden({name: 'comment_id', value: -1}) +
            $h.hidden({name: 'parent_id', value: -1}) +
            $h.textarea({name: 'comment', cols: 60, rows: 10}) + $h.br() +
            $h.button({name: 'post_comment', value: 'Send comment'});
        }) + $h.div({id: 'errormsg'}) :
        $h.br()); // render_comments_for_news(news["id"])
  });

  res.send(html);
});

app.get('/user/:username', async (req, res, next) => {
  let username = req.params.username;
  let user = await getUserByUsername(username);
  if (!user) return res.status(404).send('Non existing user');
  let [posted_news, posted_comments] = await $r.pipeline([
    ['zcard', `user.posted:${user.id}`],
    ['zcard', `user.comments:${user.id}`]
  ]).exec();
  $h.setTitle(`${user.username} - ${siteName}`);
  let owner = $user && ($user.id == user.id);
  let html = $h.page(
    $h.div({class: 'userinfo'}, () => {
      return $h.span({class: 'avatar'}, () => {
        let email = user.email || '';
        let digest = createHash('md5').update(email).digest('hex');
        return $h.img({src: `//gravatar.com/avatar/${digest}?s=48&d=mm`});
      }) + ' ' +
      $h.h2($h.entities(user.username)) +
      $h.pre($h.entities(user.about)) +
      $h.ul(() => {
        return $h.li($h.b('created ') + strElapsed(+ user.ctime)) +
          $h.li($h.b('karma ') + `${user.karma} points`) +
          $h.li($h.b('posted news ') + `${posted_news[1]}`) +
          $h.li($h.b('posted comments ') + `${posted_comments[1]}`) +
          (owner ? $h.li($h.a({href: '/saved/0'}, 'saved news')) : '') +
          $h.li($h.a({href: `/usercomments/${$h.urlencode(user.username)}/0`}, 'user comments')) +
          $h.li($h.a({href: `/usernews/${$h.urlencode(user.username)}/0`}, 'user news'));
      }); 
    }) + (owner ? $h.append($h.script('$(function(){$("input[name=update_profile]").click(update_profile);});'), 'body') && 
      $h.br() + $h.form({name: 'f'}, () => {
        return $h.label({for: 'email'}, 'email (not visible, used for gravatar)') + $h.br() +
          $h.text({id: 'email', name: 'email', size: 40, value: $h.entities(user.email)}) + $h.br() +
          $h.label({for: 'password'}, 'change password (optional)') + $h.br() +
          $h.password({name: 'password', size: 40}) + $h.br() +
          $h.label({for: 'about'}, 'about') + $h.br() +
          $h.textarea({id: 'about', name: 'about', cols: 60, rows: 10}, $h.entities(user.about)) + $h.br() +
          $h.button({name: 'update_profile', value: 'Update profile'});
      }) + $h.div({id: 'errormsg'}) : ''));
  res.send(html);
});

app.get('/usernews/:username/:start', async (req, res, next) => {
  let start = + req.params.start;
  let user = await getUserByUsername(req.params.username);
  if (typeof start != 'number' || isNaN(start)) return next();
  if (!user) return res.status(404).send('Non existing user');

  $h.setTitle(`News posted by ${user.username} - ${siteName}`);
  let paginate = {
    get: async (start, count) => {
      return await getPostedNews(user.id, start, count);
    },
    render: (item) => {
      return newsToHTML(item);
    },
    start: start,
    perpage: savedNewsPerPage,
    link: `/usernews/${$h.entities(user.username)}/$`
  }
  let newslist = await listItems(paginate);
  res.send($h.page(() => {
    return $h.h2(`News posted by ${user.username}`) +
      $h.section({id: 'newslist'}, newslist);
  }));
});

app.get('/saved/:start', async (req, res, next) => {
  let start = + req.params.start;
  if (!$user) return res.redirect('/login');
  if (typeof start != 'number' || isNaN(start)) return next();

  $h.setTitle(`Saved news - ${siteName}`);
  let paginate = {
    get: async (start, count) => {
      return await getSavedNews($user.id, start, count);
    },
    render: (item) => {
      return newsToHTML(item);
    },
    start: start,
    perpage: savedNewsPerPage,
    link: '/saved/$'
  }
  let newslist = await listItems(paginate);
  res.send($h.page(() => {
    return $h.h2('You saved News') +
      $h.section({id: 'newslist'}, newslist);
  }));
});

app.get('/admin', async (req, res, next) => {
  if(!$user || !isAdmin($user)) return res.redirect('/');
  let user_count = await $r.get('users.count');
  let news_count = await $r.zcard('news.cron');
  let used_memory = await $r.info('memory');

  $h.setTitle(`Admin section - ${siteName}`);
  res.send($h.page(
    $h.div({id: 'adminlinks'}, () => {
      return $h.h2('Admin') +
        $h.h3('Site stats') +
        $h.ul(() => {
          return $h.li(`${user_count} users`) +
            $h.li(`${news_count} news posted`) +
            $h.li(`${used_memory.match(/used_memory_human:(\S*)/)[1]} of memory used`);
        }) +
        $h.h3('Developer tools') +
        $h.ul(
          $h.li($h.a({href: '/recompute'}, 'Recompute news score and rank (may be slow!)')) +
          $h.li($h.a({href: '/?debug=1'}, 'Show annotated home page'))
        );
    })
  ));
});

app.get('/recompute', async (req, res) => {
  if (!$user || !isAdmin($user)) return res.redirect('/');
  let range = await $r.zrange('news.cron', 0, -1);
  for (let news_id of range) {
    let news = await getNewsById(news_id);
    let score = await computeNewsScore(news)
    let rank = computeNewsRank(news)
    await $r.hmset(`news:${news_id}`, 'score', score, 'rank', rank)
    await $r.zadd('news.top', rank, news_id)
  }
  res.send($h.page($h.p('Done.')));
});

app.get('/submit', (req, res) => {
  let {t, u} = req.query;
  if (!$user) return res.redirect('/login');
  $h.setTitle(`Submit a new story - ${siteName}`);
  $h.append($h.script('$(function() {$("input[name=do_submit]").click(submit);});'), 'body');
  res.send($h.page(
    $h.h2('Submit a new story') +
    $h.div({id: 'submitform'},
      $h.form({name: 'f'},
        $h.hidden({name: 'news_id', value: -1}) +
        $h.label({for: 'title'}, 'title') +
        $h.text({id: 'title', name: 'title', size: 80, value: (t ? $h.entities(t) : '')}) + $h.br() +
        $h.label({for: 'url'}, 'url') + $h.br() +
        $h.text({id: 'url', name: 'url', size: 60, value: (u ? $h.entities(u) : '')}) + $h.br() +
        'or if you don\'t have an url type some text' + $h.br() +
        $h.label({for: 'text'}, 'text') +
        $h.textarea({id: 'text', name: 'text', cols: 60, rows: 10}) +
        $h.button({name: 'do_submit', value: 'Submit'})
      )
    ) +
    $h.div({class: 'errormsg'}) +
    $h.p(() => {
      let bl = `javascript:window.location=%22${siteUrl}/submit?u=%22+encodeURIComponent(document.location)+%22&t=%22+encodeURIComponent(document.title)`;
      return 'Submitting news is simpler using the ' + $h.a({href: bl}, 'bookmarklet') +
        ' (drag the link to your browser toolbar)';
    })
  ));
});

app.get('/login', (req, res) => {
  $h.setTitle(`Login - ${siteName}`);
  let script = $h.script('$(function() {$("form[name=f]").submit(login);});');
  $h.append(script, 'body');
  let html = $h.page(
    $h.div({id: 'login'}, () => {
      return $h.form({name: 'f'},
        $h.label({for: 'username'}, 'username') +
        $h.text({id: 'username', name: 'username', required: true}) +
        $h.label({for: 'password'}, 'password') +
        $h.password({id: 'password', name: 'password', required: true}) + $h.br() +
        $h.checkbox({name: 'register', value: 1}) + 'create account' + $h.br() +
        $h.submit({name: 'do_login'}, 'Login')
      );
    }) + $h.div({id: 'errormsg'}) + $h.a({href: '/reset-password'}, 'reset password')
  );

  res.send(html);
});

app.get('/logout', async (req, res) => {
  let {apisecret} = req.query;
  if ($user && checkApiSecret(apisecret)) {
    await updateAuthToken($user);
  }
  res.redirect('/');
});

// API implementation
app.get('/api/login', async (req, res) => {
  let params = req.query;
  if (!checkParams(params, 'username', 'password'))
    return res.json({status: 'err', error: 'Username and password are two required fields.'});

  let [auth, apisecret] = await checkUserCredentials(params.username, params.password) || [];
  res.json(auth ? {status: 'ok', auth: auth, apisecret: apisecret} : {status: 'err', error: 'No match for the specified username / password pair.'});
});

app.post('/api/create_account', async (req, res) => {
  let {username, password} = req.body;
  if (!checkParams(req.body, 'username', 'password'))
    return res.json({status: 'err', error: 'Username and password are two required fields.'});
  if (!usernameRegexp.test(username))
    return res.json({status: 'err', error: `Username must match /${usernameRegexp.source}/`});
  if(password.length < passwordMinLength)
    return res.json({status: err, error: `Password is too short. Min length: ${passwordMinLength}`});

  let [auth, apisecret, errmsg] = await createUser(username, password, {ip: req.ip});
  if (auth)
    return res.json({status: 'ok', auth: auth, apisecret: apisecret});
  res.json({status: 'err', error: errmsg});
});

// catch 404 and forward to error handler
app.use(function(req, res, next) {
  var err = new Error('Not Found');
  err.status = 404;
  next(err);
});

// error handlers

// development error handler
// will print stacktrace
if (app.get('env') === 'development') {
  app.use(function(err, req, res, next) {
    res.status(err.status || 500);
    res.send({
      message: err.message,
      error: err
    });
  });
}

// production error handler
// no stacktraces leaked to user
app.use(function(err, req, res, next) {
  res.status(err.status || 500);
  res.send({
    message: err.message,
    err: {}
  });
});

function checkApiSecret(apisecret) {
  if (!$user) return false;
  return apisecret && apisecret == $user.apisecret;
}

// Navigation, header and footer
function applicationHeader() {
  let navitems = [
    ['top', '/'],
    ['latest', '/latest/0'],
    ['random', '/random'],
    ['submit', '/submit']
  ];

  let navbar_replies_link = $user ? $h.a({href: '/replies', class: 'replies'}, () => {
    let count = $user.replies || 0;
    return 'replies ' + (parseInt(count) > 0 ? $h.sup(count) : '');
  }) : '';

  let navbar_admin_link = $user && isAdmin($user) ? $h.a({href: '/admin'}, $h.b('admin')) : '';

  let navbar = $h.nav(navitems.map((ni) => {
    return $h.a({href: ni[1]}, $h.entities(ni[0]));
  }).join('') + navbar_replies_link + navbar_admin_link);

  let rnavbar = $h.nav({id: 'account'}, () => {
    return $user ?
      $h.a(
        {href: `/user/${$h.urlencode($user.username)}`},
        $h.entities($user.username + ` (${$user.karma})`)
      ) + ' | ' +
      $h.a({href: `/logout?apisecret=${$user.apisecret}`}, 'logout') :
      $h.a({href: '/login'}, 'login / register');
  });

  let mobile_menu = $h.a({href: '#', id: 'link-menu-mobile'}, '<~>');

  return $h.header(
    $h.h1(
      $h.a({href: '/'}, $h.entities(siteName) + ' ' + $h.small(version))
    ) + navbar + rnavbar + mobile_menu
  );
}

function applicationFooter() {
  return $h.footer(() => {
    let links = [
      ['about', '/about'],
      ['source code', 'https://github.com/7anshuai/jsernews'],
      ['rss feed', '/rss'],
      // ['twitter', footerTwitterLink]
    ];

    return links.map((l) => {
      return l[1] ? $h.a({href: l[1]}, $h.entities(l[0])) : null;
    }).filter((l) => {
      return l;
    }).join(' | ');
  }) + (keyboardNavigation == 1 ? $h.div({id: 'keyboard-help', style: 'display: none;'}, () => {
    return $h.div({class: 'keyboard-help-banner banner-background banner'}) + ' ' + 
      $h.div({class: 'keyboard-help-banner banner-foreground banner'}, () => {
        return $h.div({class: 'primary-message'}, 'Keyboard shortcuts') + ' ' +
          $h.div({class: 'secondary-message'}, () => {
            return $h.p($h.strong({class: 'key'}, 'j/k:') + $h.span({class: 'desc'}, 'next/previous item')) +
              $h.p($h.strong({class: 'key'}, 'enter:') + $h.span({class: 'desc'}, 'open link')) +
              $h.p($h.strong({class: 'key'}, 'a/z:') + $h.span({class: 'desc'}, 'up/down vote item'));
          });
      });
  }) : '');
}

// Generic API limiting function
// function rate_limit_by_ip(delay, *tags){
//   let key = "limit:"+tags.join(".");
//   if ($r.exists(key)) return true;
//   $r.setex(key,delay,1);
//   return false
// }

// Show list of items with show-more style pagination.
//
// The function sole argument is an hash with the following fields:
//
// :get     A function accepinng start/count that will return two values:
//          1) A list of elements to paginate.
//          2) The total amount of items of this type.
//
// :render  A function that given an element obtained with :get will turn
//          in into a suitable representation (usually HTML).
//
// :start   The current start (probably obtained from URL).
//
// :perpage Number of items to show per page.
//
// :link    A string that is used to obtain the url of the [more] link
//          replacing '$' with the right value for the next page.
//
// Return value: the current page rendering.
async function listItems(o){
  let aux = "";
  if (o.start < 0) o.start = 0;
  let [items, count] = await o.get.call(o, o.start, o.perpage);

  items.forEach((n) => {
    aux += o.render.call(o, n);
  })

  let last_displayed = parseInt(o.start + o.perpage);
  if (last_displayed < count) {
      let nextpage = o.link.replace("$", last_displayed);
      aux += $h.a({href: nextpage, class: "more"}, '[more]');
  }
  return aux;
}

module.exports = app;