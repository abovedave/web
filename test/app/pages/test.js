${typeof names !== 'undefined' ? names.map(n => `${n.title} ${n.name}`).join('\n') : ''}${typeof categories !== 'undefined' ? categories.results.map(c => `<h3>${c.name}</h3>`).join('') : ''}