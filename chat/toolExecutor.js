'use strict';

import { runSql } from "./sqlRunner.js";

export function executeTool(db, toolName, args) {
  switch (toolName) {

    case "query_fields": {
      const where = [];
      if (args.county) where.push(`fields.county_norm LIKE '%${args.county.toLowerCase()}%'`);
      if (args.farm) where.push(`farms.name_norm LIKE '%${args.farm.toLowerCase()}%'`);
      if (args.rtkTower) where.push(`rtkTowers.name_norm LIKE '%${args.rtkTower.toLowerCase()}%'`);
      if (args.metric && args.metricGt != null) {
        const col = args.metric === "hel" ? "helAcres" : args.metric === "crp" ? "crpAcres" : "tillable";
        where.push(`COALESCE(fields.${col},0) > ${Number(args.metricGt)}`);
      }

      const group =
        args.groupBy === "county"
          ? "GROUP BY fields.county_norm"
          : args.groupBy === "farm"
          ? "GROUP BY farms.name_norm"
          : "";

      const sql = `
        SELECT
          fields.name AS field,
          fields.county AS county,
          fields.state AS state,
          fields.helAcres,
          fields.crpAcres,
          fields.tillable
        FROM fields
        LEFT JOIN farms ON fields.farmId = farms.id
        LEFT JOIN rtkTowers ON fields.rtkTowerId = rtkTowers.id
        ${where.length ? "WHERE " + where.join(" AND ") : ""}
        ${group}
        ORDER BY fields.name_norm
        LIMIT ${args.limit || 200}
      `;

      return runSql({ db, sql });
    }

    case "field_info": {
      const sql = `
        SELECT
          fields.*,
          farms.name AS farm,
          rtkTowers.name AS rtkTower,
          rtkTowers.frequencyMHz,
          rtkTowers.networkId
        FROM fields
        LEFT JOIN farms ON fields.farmId = farms.id
        LEFT JOIN rtkTowers ON fields.rtkTowerId = rtkTowers.id
        WHERE fields.name_norm LIKE '%${args.field.toLowerCase()}%'
        LIMIT 5
      `;
      return runSql({ db, sql });
    }

    case "rtk_info": {
      const sql = `
        SELECT
          name AS tower,
          frequencyMHz,
          networkId
        FROM rtkTowers
        WHERE name_norm LIKE '%${args.tower.toLowerCase()}%'
        LIMIT 5
      `;
      return runSql({ db, sql });
    }

    default:
      return { ok: false, error: "unknown_tool" };
  }
}
