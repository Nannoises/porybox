const pk6parse = require('pk6parse');
const moment = require('moment');
module.exports = _.mapValues({
  async uploadpk6 (req, res) {
    const params = req.allParams();
    let visibility;
    if (params.visibility) {
      visibility = params.visibility;
      Validation.verifyPokemonParams({visibility});
    } else {
      visibility = (await UserPreferences.findOne({
        user: req.user.name
      })).defaultPokemonVisibility;
    }
    const files = await new Promise((resolve, reject) => {
      req.file('pk6').upload((err, files) => err ? reject(err) : resolve(files));
    });
    if (!files.length) {
      return res.status(400).json('No files uploaded');
    }
    const parsed = _.attempt(pk6parse.parseFile, files[0].fd);
    if (_.isError(parsed)) {
      return res.status(400).json('Failed to parse the provided file');
    }
    let box;
    if (params.box) {
      box = await Box.findOne({id: params.box});
      if (!box) {
        return res.status(400).json(`Box ${params.box} not found`);
      }
      if (box.owner !== req.user.name) {
        return res.status(403).json("Cannot upload to another user's box");
      }
    } else {
      box = await Box.create({
        name: `Untitled Box ${moment.utc().format('YYYY-MM-DD HH:mm:ss')}`,
        owner: req.user.name,
        id: require('crypto').randomBytes(16).toString('hex')
      });
    }
    parsed.box = box.id;
    parsed.owner = req.user.name;
    parsed.visibility = visibility;
    parsed.cloneHash = PokemonHandler.computeCloneHash(parsed);
    parsed.id = require('crypto').randomBytes(16).toString('hex');
    const result = await Pokemon.create(parsed);
    result.isUnique = await result.checkIfUnique();
    return res.created(result);
  },

  async get (req, res) {
    const pokemon = await Pokemon.findOne({
      id: req.param('id'),
      _markedForDeletion: false
    }).populate('notes');
    if (!pokemon) {
      return res.notFound();
    }
    pokemon.isUnique = await pokemon.checkIfUnique();
    const pokemonIsPublic = pokemon.visibility === 'public';
    const userIsOwner = !!req.user && req.user.name === pokemon.owner;
    const userIsAdmin = !!req.user && req.user.isAdmin;
    if (pokemonIsPublic || userIsOwner || userIsAdmin) {
      return res.ok(pokemon);
    }
    if (pokemon.visibility === 'private') {
      return res.forbidden();
    }
    return res.ok(pokemon.omitPrivateData());
  },

  async delete (req, res) {
    const id = req.param('id');
    let pokemon = await Validation.verifyUserIsPokemonOwner({user: req.user, id});
    await pokemon.markForDeletion();
    res.send(202);
    await Promise.delay(req.param('immediately') ? 0 : Constants.POKEMON_DELETION_DELAY);
    pokemon = await Pokemon.findOne({id});
    if (pokemon._markedForDeletion) {
      await pokemon.destroy();
    }
  },

  async undelete (req, res) {
    const params = req.allParams();
    const pokemon = await Validation.verifyUserIsPokemonOwner({
      user: req.user,
      id: params.id,
      allowDeleted: true
    });
    await pokemon.unmarkForDeletion();
    return res.ok();
  },

  async mine (req, res) {
    const myPokemon = await Pokemon.find({owner: req.user.name, _markedForDeletion: false});
    await Promise.map(myPokemon, async pkmn => {
      pkmn.isUnique = await pkmn.checkIfUnique();
    });
    return res.ok(myPokemon);
  },

  async download (req, res) {
    const pokemon = await Pokemon.findOne({id: req.param('id'), _markedForDeletion: false});
    if (!pokemon) {
      return res.notFound();
    }
    const userIsOwner = !!req.user && req.user.name === pokemon.owner;
    const userIsAdmin = !!req.user && req.user.isAdmin;
    if (pokemon.visibility !== 'public' && !userIsOwner && !userIsAdmin) {
      return res.forbidden();
    }
    res.status(200).json(pokemon._rawPk6);
    if (!userIsOwner && pokemon.visibility === 'public') {
      pokemon.downloadCount++;
      await pokemon.save();
    }
  },

  async move (req, res) {
    const params = req.allParams();
    Validation.requireParams(params, ['id', 'box']);
    const pokemon = await Validation.verifyUserIsPokemonOwner({user: req.user, id: params.id});
    const newBox = await Validation.verifyUserIsBoxOwner({user: req.user, id: params.box});
    if (pokemon.owner !== newBox.owner) {
      return res.forbidden();
    }
    pokemon.box = newBox.id;
    await pokemon.save();
    return res.ok();
  },
  async addNote (req, res) {
    const params = req.allParams();
    Validation.requireParams(params, ['id', 'text']);
    const pokemon = await Validation.verifyUserIsPokemonOwner({user: req.user, id: params.id});
    let visibility;
    if (params.visibility) {
      visibility = params.visibility;
    } else {
      visibility = (await UserPreferences.findOne({
        user: req.user.name
      })).defaultPokemonNoteVisibility;
    }
    const newNoteParams = {
      text: params.text,
      visibility,
      pokemon,
      id: require('crypto').randomBytes(16).toString('hex')
    };
    Validation.verifyPokemonNoteParams(newNoteParams);
    const newNote = await PokemonNote.create(newNoteParams);
    return res.created(newNote);
  },

  async deleteNote (req, res) {
    const params = req.allParams();
    Validation.requireParams(params, ['id', 'noteId']);
    const pokemon = await Pokemon.findOne({id: params.id, _markedForDeletion: false});
    if (!pokemon) {
      return res.notFound();
    }
    if (pokemon.owner !== req.user.name && !req.user.isAdmin) {
      return res.forbidden();
    }
    const note = await PokemonNote.findOne({id: params.noteId, pokemon: params.id});
    if (!note) {
      return res.notFound();
    }
    await note.destroy();
    return res.ok();
  },

  async editNote (req, res) {
    const params = req.allParams();
    Validation.requireParams(params, ['id', 'noteId']);
    const filteredParams = Validation.filterParams(params, ['text', 'visibility']);
    await Validation.verifyUserIsPokemonOwner({user: req.user, id: params.id});
    const note = await PokemonNote.findOne({id: params.noteId, pokemon: params.id});
    if (!note) {
      return res.notFound();
    }
    _.assign(note, filteredParams);
    Validation.verifyPokemonNoteParams(note);
    await note.save();
    return res.ok(note);
  },

  async edit (req, res) {
    const params = req.allParams();
    Validation.requireParams(params, 'id');
    const filteredParams = Validation.filterParams(params, ['visibility']);
    const pokemon = await Validation.verifyUserIsPokemonOwner({user: req.user, id: params.id});
    _.assign(pokemon, filteredParams);
    Validation.verifyPokemonParams(pokemon);
    await pokemon.save();
    return res.ok(pokemon);
  }
}, CatchAsyncErrors);
