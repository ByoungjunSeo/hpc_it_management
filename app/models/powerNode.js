const { getDb } = require('../config/database');

const PowerNode = {
  findByRoom(roomId) {
    return getDb().prepare(`
      SELECT pn.*, a.asset_number, a.model_name as asset_model
      FROM power_nodes pn
      LEFT JOIN assets a ON pn.asset_id = a.id
      WHERE pn.room_id = ?
      ORDER BY pn.sort_order, pn.id
    `).all(roomId);
  },

  findById(id) {
    return getDb().prepare(`
      SELECT pn.*, a.asset_number, a.model_name as asset_model
      FROM power_nodes pn
      LEFT JOIN assets a ON pn.asset_id = a.id
      WHERE pn.id = ?
    `).get(id);
  },

  findChildren(parentId) {
    return getDb().prepare(`
      SELECT pn.*, a.asset_number, a.model_name as asset_model
      FROM power_nodes pn
      LEFT JOIN assets a ON pn.asset_id = a.id
      WHERE pn.parent_id = ?
      ORDER BY pn.sort_order, pn.id
    `).all(parentId);
  },

  create(data) {
    const stmt = getDb().prepare(`
      INSERT INTO power_nodes (room_id, parent_id, node_type, name, capacity_kw, rating, voltage, phase, circuit_number, asset_id, description, sort_order)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      data.room_id,
      data.parent_id || null,
      data.node_type,
      data.name,
      data.capacity_kw || null,
      data.rating || null,
      data.voltage || null,
      data.phase || null,
      data.circuit_number || null,
      data.asset_id || null,
      data.description || null,
      data.sort_order || 0
    );
    return result.lastInsertRowid;
  },

  update(id, data) {
    const stmt = getDb().prepare(`
      UPDATE power_nodes SET
        node_type=?, name=?, capacity_kw=?, rating=?, voltage=?, phase=?,
        circuit_number=?, asset_id=?, description=?, sort_order=?,
        updated_at=CURRENT_TIMESTAMP
      WHERE id=?
    `);
    return stmt.run(
      data.node_type,
      data.name,
      data.capacity_kw || null,
      data.rating || null,
      data.voltage || null,
      data.phase || null,
      data.circuit_number || null,
      data.asset_id || null,
      data.description || null,
      data.sort_order || 0,
      id
    );
  },

  delete(id) {
    return getDb().prepare('DELETE FROM power_nodes WHERE id = ?').run(id);
  },

  buildTree(nodes) {
    const map = {};
    const roots = [];
    nodes.forEach(n => {
      map[n.id] = { ...n, children: [] };
    });
    nodes.forEach(n => {
      if (n.parent_id && map[n.parent_id]) {
        map[n.parent_id].children.push(map[n.id]);
      } else {
        roots.push(map[n.id]);
      }
    });
    return roots;
  }
};

module.exports = PowerNode;
