# dependencies
CSON = require 'cson'
Firebase = require 'firebase'
async = require 'async'
extend =  require 'node.extend'
fs = require 'fs'
mkdirp = require 'mkdirp'
mongofb = require 'mongofb'
ncp = require('ncp').ncp
open = require 'open'
optimist = require 'optimist'
path = require 'path'
readline = require 'readline'

# usage
USAGE = """
Usage: dobi <command> [command-specific-options]

where <command> [command-specific-options] is one of:
  create <my-package> <type=app>    create a new package
  deploy <my-app>                   deploy an app (COMING SOON)
  init                              initialize a workspace
  install <my-app> <site-slug>      create a site using your app
  login                             authenticate your user
  open <site-slug>                  open a site
  run                               run a development server
  start                             daemonize a development server
  stop                              stop a daemonized development server
  version                           check your dobi version
  whoami                            check your authentication status
"""

# constants
CWD = process.cwd()
DATABASE_URL = 'http://www.dobi.io/db/1.0'
FIREBASE_URL = 'https://lessthan3.firebaseio.com'
USER_HOME = process.env.HOME or process.env.HOMEPATH or process.env.USERPROFILE
USER_CONFIG_PATH = "#{USER_HOME}/.lt3_config"

# helpers
rl = readline.createInterface {
  input: process.stdin
  output: process.stdout
}

connect = (next) ->
  login (config) ->
    user = config?.user
    exit "please login first: 'dobi login'" unless user
    db = new mongofb.client.Database {
      server: DATABASE_URL
      firebase: FIREBASE_URL
    }
    db.cache = false
    db.auth config.token, (err) ->
      exit "error authenticating" if err
      next user, db
 
exit = (msg) ->
  log msg if msg
  process.exit()

getWorkspacePath = (current, next) ->
  [current, next] = [CWD, current] if not next
  fs.exists path.join(current, 'dobi.json'), (exists) ->
    if exists
      next current
    else
      parent = path.join current, '..'
      return next null if parent is current
      getWorkspacePath parent, next

log = (msg) ->
  console.log "[dobi] #{msg}"

login = (require_logged_in, next) ->
  [require_logged_in, next] = [false, require_logged_in] unless next

  log 'authenticating user'
  readUserConfig (config) ->
    if config.user
      next config
    else if not require_logged_in
      next null
    else
      log 'not logged in: must authenticate'
      log 'opening login portal in just a few moments'
      setTimeout ( ->
        open 'http://www.dobi.io/auth'
        rl.question "Enter Token: ", (token) ->
          exit 'must specify token' unless token
          fb = new Firebase FIREBASE_URL
          fb.auth token, (err, data) ->
            exit 'invalid token' if err
            config.user = data.auth
            config.token = token
            config.token_expires = data.expires
            saveUserConfig config, ->
              next config
      ), 3000

readUserConfig = (next) ->
  fs.exists USER_CONFIG_PATH, (exists) ->
    if exists
      fs.readFile USER_CONFIG_PATH, 'utf8', (err, data) ->
        exit 'unable to read user config' if err
        next JSON.parse data
    else
      saveUserConfig {}, ->
        next {}

saveUserConfig = (data, next) ->
  config = JSON.stringify data
  fs.writeFile USER_CONFIG_PATH, config, 'utf8', (err) ->
    exit 'unable to write user config' if err
    next()

# get arguments and options
argv = optimist.argv._
command = argv[0]
args = argv[1...argv.length]
opts = optimist.argv

switch command

  # create a new app
  when 'create'
    [id, version] = args[0].split '@'
    type = args[1] or 'app'

    # check arguments
    exit "must specify package id" unless id
    exit "must specify package version" unless version
    exit "must specify package type" unless type
    exit "invalid type: #{type}" if type not in ['app', 'plugin', 'library']

    # require login
    login (config) ->
      user = config?.user
      exit "please login first: 'dobi login'" unless user

      # bootstrap the project
      source = path.join __dirname, '..', 'bootstrap', type
      getWorkspacePath (workspace) ->
        exit 'must be in a workspace to create a package' unless workspace
        dest = path.join workspace, 'pkg', id, version
        mkdirp dest, (err) ->
          exit "error creating package: #{err}" if err
          ncp source, dest, (err) ->
            exit "Error creating package: #{err}" if err

            # update config
            config_path = path.join dest, 'config.cson'
            config = CSON.parseFileSync config_path
            config.id = id
            config.version = version
            config.author.name = user.name
            config.author.email = user.email
            config = CSON.stringifySync(config).replace /\n\n/g, '\n'
            fs.writeFileSync config_path, config

            # done
            exit 'package created successfully'


  # deploy an app
  when 'deploy'
    exit 'not available yet'

  # initialize a workspace
  when 'init'
    getWorkspacePath (workspace) ->
      exit "already in a workspace: #{workspace}" if workspace
      fs.writeFile path.join(CWD, 'dobi.json'), JSON.stringify({
        created: Date.now()
      }), (err) ->
        exit 'failed to create workspace config' if err
        fs.mkdir path.join(CWD, 'pkg'), (err) ->
          exit 'failed to create pkg directory' if err
          exit "workspace successfully created at: #{CWD}"

  # create a site using your app
  when 'install'
    [id, version] = args[0].split '@'
    slug = args[1]

    exit "must specify package id" unless id
    exit "must specify package version" unless version
    exit "must specify new site slug" unless slug

    getWorkspacePath (workspace) ->
      exit 'must be in a workspace to find your package' unless workspace

      # connect to database
      connect (user, db) ->

        # make sure slug isn't taken
        db.get('sites').findOne {
          slug: slug
        }, (err, site) ->
          exit err if err
          exit "slug '#{slug}' is already taken." if site

          # read config.cson if it exists
          config_path = path.join workspace, 'pkg', id, version, 'config.cson'
          exists = fs.existsSync config_path
          config = {}
          config = CSON.parseFileSync config_path if exists

          # read setup.cson if it exists
          setup_path = path.join workspace, 'pkg', id, version, 'setup.cson'
          exists = fs.existsSync setup_path
          setup = {}
          setup = CSON.parseFileSync setup_path if exists

          # check validity of setup.cson
          setup.objects ?= []
          for object in setup.objects
            unless object.collection
              exit "object in setup.cson missing 'collection'"
            unless object.type
              exit "object in setup.cson missing 'type'"
            if not object.slug and object.slug != ''
              exit "object in setup.cson missing 'slug'"

          # update properties for this site
          site = extend true, {}, setup.site or {}, {
            created: Date.now()
            name: slug
            package:
              id: id
              version: version
            settings:
              domain:
                url: "http://www.lessthan3.com/#{slug}"
              transitions:
                mobile: 'slide'
                web: 'fade'
            slug: slug
          }

          # make user an admin
          site.users ?= {}
          site.users[user.uid] = 'admin'

          # default site properties
          site.regions ?= {}
          site.style ?= {}
          site.collections ?= {}
          config.collections ?= {}
          for k, v of config.collections
            site.collections[k] ?= {}
            site.collections[k].slug ?= k

          # insert into database
          db.get('sites').insert site, (err, site) ->
            exit err if err
            site_id = site.get('_id').val()
            log 'site has been created'

            async.forEachSeries setup.objects, ((object, next) ->
              console.log 'creating object', object.slug
              object.created = Date.now()
              object.site_id = site_id
              db.get('objects').insert object, (err) ->
                exit err if err
                next()
            ), (err) ->
              exit err if err
              log 'objects have been created'
              log 'loading site in just a moment'
              setTimeout ( ->
                open "http://www.lessthan3.com/#{slug}?dev=1"
              ), 3000

  # authenticate your user
  when 'login'
    login true, (config) ->
      exit JSON.stringify user, null, 2 if config.user
      exit 'not logged in. try "dobi login"'

  # open a site
  when 'open'
    url = 'http://www.lessthan3.com'
    url += "/#{arg}" for arg in args
    open url
    exit()

  # run a development server
  when 'run'
    getWorkspacePath (workspace) ->
      exit 'must be in a workspace to run the server' unless workspace

      # dependencies
      connect = require 'connect'
      express = require 'express'
      dobi = require './server'
      pkg = require path.join '..', 'package'

      # configuration
      app = express()
      app.use express.logger '[:date] :status :method :url'
      app.use connect.urlencoded()
      app.use connect.json()
      app.use express.methodOverride()
      app.use express.cookieParser()
      app.use dobi {
        pkg_dir: path.join workspace, 'pkg'
      }
      app.use app.router
      app.use express.errorHandler {dumpExceptions: true, showStack: true}

      # listen
      app.listen pkg.config.port
      log "listening: #{pkg.config.port}"

  # daemonize a development server
  when 'start'
    login (config) ->
      ((next) ->
        if config.pid
          log "killing running server: #{config.pid}" if config.pid
          try process.kill config.pid, 'SIGHUP'
          config.pid = null
          saveUserConfig config, next
        else
          next()
      )( ->
        log "starting process"
        cp = require 'child_process'
        child = cp.spawn 'coffee', ["#{__dirname}/dobi.coffee", 'run'], {
          detached: true
          stdio: [ 'ignore', 'ignore', 'ignore']
        }
        child.unref()
        config.pid = child.pid
        log "server running at: #{config.pid}"
        saveUserConfig config, exit
      )

  # daemonize a development server
  when 'stop'
    login (config) ->
      return exit() if not config.pid
      try process.kill config.pid, 'SIGHUP'
      config.pid = null
      saveUserConfig config, exit

  # check your dobi version
  when 'version'
    pkg = require path.join '..', 'package'
    exit pkg.version

  # check your authentication status
  when 'whoami'
    login (config) ->
      exit JSON.stringify user, null, 2 if config.user
      exit 'not logged in. try "dobi login"'

  # invalid command
  else
    exit "invalid command: #{command}"
