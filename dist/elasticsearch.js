var ES = {};

(function(my) {
    // use either jQuery or Underscore Deferred depending on what is available
    var Deferred = _.isUndefined(this.jQuery) ? _.Deferred : jQuery.Deferred;

    // ## Table
    //
    // A simple JS wrapper around an [ElasticSearch](http://www.elasticsearch.org/) Type / Table endpoint.
    //
    // @param {String} endpoint: url for ElasticSearch type/table, e.g. for ES running
    // on http://localhost:9200 with index twitter and type tweet it would be:
    // 
    // <pre>http://localhost:9200/twitter/tweet</pre>
    //
    // @param {Object} options: set of options such as:
    //
    // * headers - {dict of headers to add to each request}
    // * dataType: dataType for AJAX requests e.g. set to jsonp to make jsonp requests (default is json requests)
    my.Table = function(endpoint, options) {
        var self = this;
        this.endpoint = endpoint;
        this.options = _.extend({
                dataType: 'json'
            },
            options);

        // ### mapping
        //
        // Get ES mapping for this type/table
        //
        // @return promise compatible deferred object.
        this.mapping = function() {
            var schemaUrl = self.endpoint + '/_mapping';
            var jqxhr = makeRequest({
                url: schemaUrl,
                dataType: this.options.dataType
            });
            return jqxhr;
        };

        // ### get
        //
        // Get record corresponding to specified id
        //
        // @return promise compatible deferred object.
        this.get = function(id) {
            var base = this.endpoint + '/' + id;
            return makeRequest({
                url: base,
                dataType: 'json'
            });
        };

        // ### upsert
        //
        // create / update a record to ElasticSearch backend
        //
        // @param {Object} doc an object to insert to the index.
        // @return deferred supporting promise API
        this.upsert = function(doc) {
            var data = JSON.stringify(doc);
            url = this.endpoint;
            if (doc.id) {
                url += '/' + doc.id;
            }
            return makeRequest({
                url: url,
                type: 'POST',
                data: data,
                dataType: 'json'
            });
        };

        // ### update
        //
        // update a record to ElasticSearch backend
        //
        // @param {Object} doc an object to update to the index.
        // @param {String} id of the doc to update
        // @return deferred supporting promise API
        this.update = function(doc, doc_id) {
            var upd = {
                "doc": doc
            };
            var data = JSON.stringify({
                "doc": doc
            })
            return makeRequest({
                url: this.endpoint + '/' + doc_id + '/_update',
                type: 'POST',
                data: data,
                dataType: 'json'
            });
        };

        // ### delete
        //
        // Delete a record from the ElasticSearch backend.
        //
        // @param {Object} id id of object to delete
        // @return deferred supporting promise API
        this.remove = function(id) {
            url = this.endpoint;
            url += '/' + id;
            return makeRequest({
                url: url,
                type: 'DELETE',
                dataType: 'json'
            });
        };

        this._normalizeQuery = function(queryObj) {
            var self = this;
            var queryInfo = (queryObj && queryObj.toJSON) ? queryObj.toJSON() : _.extend({}, queryObj);
            var query;

            var booleanize = false;
            if (queryInfo.q) {
                booleanize = true;
                var qStr = {
                    query_string: {
                        query: queryInfo.q
                    }
                };
                query = {
                    bool: {
                        must: [],
                        must_not: [],
                        should: []
                    }
                }
                if (queryInfo.boostFields) {
                    var _fields = _.map(queryInfo.boostFields, function(boostField) {
                        var str = boostField.field;
                        if (boostField.boost && boostField.boost > 0) {
                            str = str + "^" + boostField.boost;
                        }
                        return str;
                    });
                    qStr.query_string.fields = _fields;
                }
                qStr.query_string.lenient = true;
                qStr.query_string.use_dis_max = true;
                qStr.query_string.fuzziness = 2;
                qStr.query_string.analyzer = 'custom_analyzer_combo';


                /* multi_match...
                    qStr.multi_match.fields = _fields;
                    qStr.multi_match.lenient = true;
                    qStr.multi_match.use_dis_max = true;
                    qStr.multi_match.tie_breaker = 0.3;
                    //qStr.multi_match.analyzer = "custom_analyzer_en";
                    qStr.multi_match.auto_generate_phrase_queries = true;*/
                query.bool.must.push(qStr);
                //query.min_score = 0.99;
            } else if (queryInfo.ids) {
                query = {
                    ids: {
                        values: queryInfo.ids
                    }
                }
            } else {
                booleanize = true;
                query = {
                    bool: {
                        must: [{
                            match_all: {}
                        }],
                        must_not: [],
                        should: []
                    }
                }
            }

            if (booleanize) {
                if (queryObj.bool) {
                    _.each(queryObj.bool.must, function(arg) {
                        var tuple = {};
                        tuple[arg.field] = arg.value;
                        query.bool.must.push({
                            term: tuple
                        });
                    });
                    _.each(queryObj.bool.should, function(arg) {
                        var tuple = {};
                        tuple[arg.field] = arg.value;
                        query.bool.should.push({
                            term: tuple
                        });
                    });
                    _.each(queryObj.bool.must_not, function(arg) {
                        var tuple = {};
                        tuple[arg.field] = arg.value;
                        query.bool.must_not.push({
                            term: tuple
                        });
                    });
                    query.bool.minimum_should_match = 1;
                }
            }

            var out;
            if (queryInfo.filters && queryInfo.filters.length) {
                out = {
                    filtered: {
                        filter: {
                            and: []
                        }
                    }
                };
                // add filters
                _.each(queryInfo.filters, function(filter) {
                    if (filter.type == 'date_range') {
                        var key = filter.field.replace(/\./g, "_");
                        filter.format = queryInfo.aggs[key].date_range.format;
                    }
                    out.filtered.filter.and.push(self._convertFilter(filter));
                });
                // add query string only if needed
                if (queryInfo.q || queryInfo.ids) {
                    out.filtered.query = query;
                }
            } else {
                out = {};
                out = query;
            }            

            return out;
        },
        // convert from Recline sort structure to ES form
        // http://www.elasticsearch.org/guide/reference/api/search/sort.html
        this._normalizeSort = function(sort) {
            var out = _.map(sort, function(sortObj) {
                var _tmp = {};
                var _tmp2 = _.clone(sortObj);
                delete _tmp2['field'];
                _tmp[sortObj.field] = _tmp2;
                return _tmp;
            });
            return out;
        },

        this._convertFilter = function(filter) {
            var out = {};
            out[filter.type] = {};
            if (filter.type === 'term') {
                out.term[filter.field] = filter.term;
            } else if (filter.type === 'terms') {
                // http://www.elasticsearch.org/guide/en/elasticsearch/reference/current/query-dsl-terms-filter.html
                out.terms[filter.field] = filter.terms;
                if ('execution' in filter) {
                    out.terms['execution'] = filter.execution;
                }
            } else if (filter.type === 'geo_distance') {
                out.geo_distance[filter.field] = filter.point;
                out.geo_distance.distance = filter.distance;
                out.geo_distance.unit = filter.unit;
            } else if (filter.type === 'range') {
                // range filter: http://www.elasticsearch.org/guide/reference/query-dsl/range-filter/
                out.range[filter.field] = {};
                if (!_.isUndefined(filter.from) && !isNaN(filter.from) && filter.from) {
                    out.range[filter.field].from = filter.from;
                }
                if (!_.isUndefined(filter.to) && !isNaN(filter.to) && filter.to) {
                    out.range[filter.field].to = filter.to;
                }
                if (_.has(filter, 'include_lower')) {
                    out.range[filter.field].include_lower = filter.include_lower;
                }
                if (_.has(filter, 'include_upper')) {
                    out.range[filter.field].include_upper = filter.include_upper;
                }
            } else if (filter.type === 'date_range') {
                // range filter: http://www.elasticsearch.org/guide/reference/query-dsl/range-filter/
                //there is no date_range filter, so we need to parse in milliseconds
                out["range"] = {};
                out.range[filter.field] = {};
                if (!_.isUndefined(filter.from) && !_.isNaN(filter.from) && filter.from) {
                    out.range[filter.field].from = filter.from;
                }
                if (!_.isUndefined(filter.to) && !_.isNaN(filter.to) && filter.to) {
                    out.range[filter.field].to = filter.to;
                }

                if (_.has(filter, 'include_lower')) {
                    out.range[filter.field].include_lower = filter.include_lower;
                }
                if (_.has(filter, 'include_upper')) {
                    out.range[filter.field].include_upper = filter.include_upper;
                }
            } else if (filter.type == 'type') {
                // type filter: http://www.elasticsearch.org/guide/reference/query-dsl/type-filter/
                out.type = {
                    value: filter.value
                };
            } else if (filter.type == 'exists') {
                // exists filter: http://www.elasticsearch.org/guide/en/elasticsearch/reference/current/query-dsl-exists-filter.html
                out.exists = {
                    field: filter.field
                };
            } else if (filter.type == 'missing') {
                // missing filter: http://www.elasticsearch.org/guide/en/elasticsearch/reference/current/query-dsl-missing-filter.html
                out.missing = {
                    field: filter.field
                };
            }


            if (filter.not) {
                out = {
                    not: JSON.parse(JSON.stringify(out))
                };
            }
            return out;
        },
        this._parseDate = function(date, format) {

            if (format == "HH:mm:ss") {

            }
            var aggs = _.clone(_aggs);
            var out;
            _.each(aggs, function(agg, key) {
                if (aggs[key].selected) {
                    delete aggs[key].selected;
                }
            });
            return aggs;
        },
        this._normalizeAggregation = function(_aggs) {
            var aggs = _.clone(_aggs);
            var out;
            _.each(aggs, function(agg, key) {
                if (aggs[key].selected) {
                    delete aggs[key].selected;
                }
                if (aggs[key]._type) {
                    delete aggs[key]._type;
                }
            });
            return aggs;
        },

        this._normalizeHighlight = function(queryObj) {
            var self = this;
            var queryInfo = (queryObj && queryObj.toJSON) ? queryObj.toJSON() : _.extend({}, queryObj);
            if (queryInfo.q && queryInfo.highlights) {
                var highlights = {
                    number_of_fragments: 0,
                    pre_tags: ["<b>"],
                    post_tags: ["</b>"],
                    fields: {}
                };

                _.each(queryInfo.highlights, function(highlight) {
                    highlights.fields[highlight.field] = { 'force_source' : true }
                });
                return highlights;
            }
        },
        // ### query
        // @return deferred supporting promise API
        this.query = function(queryObj) {
            var esQuery = (queryObj && queryObj.toJSON) ? queryObj.toJSON() : _.extend({}, queryObj);
            esQuery.query = this._normalizeQuery(queryObj);

            delete esQuery.q;
            delete esQuery.filters;
            var queryType = null;
            if (esQuery.sort && esQuery.sort.length > 0) {
                esQuery.sort = this._normalizeSort(esQuery.sort);
            }
            if (esQuery.ids) {
                esQuery.size = esQuery.ids.length;
                delete esQuery.ids;
            }
            if (esQuery.boostFields) {
                delete esQuery.boostFields;
            }
            if (esQuery.highlights) {
                esQuery.highlight = this._normalizeHighlight(queryObj);
                delete esQuery.highlights;
            }
            if (esQuery.bool) {
                delete esQuery.bool;
            }
            if (esQuery.queryType) {
                queryType = esQuery.queryType;
                delete esQuery.queryType;
            }

            esQuery.aggs = this._normalizeAggregation(queryObj.aggs);
            if (queryType == 'all') {
                var aggs = _.clone(esQuery.aggs);
                aggs.top_docs = {
                    terms: {
                        field: "_type",
                        order: {
                            top_hit: "desc"
                        }
                    },
                    aggs: {
                        top_tags_hits: {
                            "top_hits": {
                                size: 10
                            }
                        },
                        top_hit: {
                            max: {
                                script: "_score",
                                lang: "groovy"
                            }
                        }
                    }
                };
                esQuery.aggs = aggs;
            }

            var data = {
                source: JSON.stringify(esQuery)
            };
            var url = this.endpoint + '/_search';
            var jqxhr = makeRequest({
                url: url,
                type: 'POST',
                data: JSON.stringify(esQuery)
            });
            return jqxhr;
        };
    };

    // ### makeRequest
    // 
    // Just $.ajax but in any headers in the 'headers' attribute of this
    // Backend instance. Example:
    //
    // <pre>
    // var jqxhr = this._makeRequest({
    //   url: the-url
    // });
    // </pre>
    var makeRequest = function(data, headers) {
        var extras = {};
        if (headers) {
            extras = {
                beforeSend: function(req) {
                    _.each(headers, function(value, key) {
                        req.setRequestHeader(key, value);
                    });
                }
            };
        }
        var data = _.extend(extras, data);
        return jQuery.ajax(data);
    };

}(ES));

var recline = recline || {};
recline.Backend = recline.Backend || {};
recline.Backend.ElasticSearch = recline.Backend.ElasticSearch || {};

(function(my) {
    "use strict";
    my.__type__ = 'elasticsearch';

    // use either jQuery or Underscore Deferred depending on what is available
    var Deferred = _.isUndefined(jQuery) ? _.Deferred : jQuery.Deferred;

    // ## Recline Connectors 
    //
    // Requires URL of ElasticSearch endpoint to be specified on the dataset
    // via the url attribute.

    // ES options which are passed through to `options` on Wrapper (see Wrapper for details)
    my.esOptions = {};

    // ### fetch
    my.fetch = function(dataset) {
        var es = new ES.Table(dataset.url, my.esOptions);
        var dfd = new Deferred();
        es.mapping().done(function(schema) {

            if (!schema) {
                dfd.reject({
                    'message': 'Elastic Search did not return a mapping'
                });
                return;
            }

            // only one top level key in ES = the type so we can ignore it
            var key = _.keys(schema)[0];
            var fieldData = _.map(schema[key].properties, function(dict, fieldName) {
                dict.id = fieldName;
                return dict;
            });
            dfd.resolve({
                fields: fieldData
            });
        })
            .fail(function(args) {
                dfd.reject(args);
            });
        return dfd.promise();
    };

    // ### save
    my.save = function(changes, dataset) {
        var es = new ES.Table(dataset.url, my.esOptions);
        if (changes.creates.length + changes.updates.length + changes.deletes.length > 1) {
            var dfd = new Deferred();
            msg = 'Saving more than one item at a time not yet supported';
            dfd.reject(msg);
            return dfd.promise();
        }
        if (changes.creates.length > 0) {
            return es.upsert(changes.creates[0]);
        } else if (changes.updates.length > 0) {
            return es.upsert(changes.updates[0]);
        } else if (changes.deletes.length > 0) {
            return es.remove(changes.deletes[0].id);
        }
    };

    // ### update
    my.update = function(doc, doc_id, dataset) {
        var es = new ES.Table(dataset.url, my.esOptions);
        return es.update(doc, doc_id);
    };

    // ### query
    my.query = function(queryObj, dataset) {
        var dfd = new Deferred();
        var es = new ES.Table(dataset.url, my.esOptions);
        var jqxhr = es.query(queryObj);
        jqxhr.done(function(results) {
            var out = {
                total: results.hits.total
            };
            out.hits = _.map(results.hits.hits, function(hit) {
                if (!('id' in hit._source) && hit._id) {
                    hit._source.id = hit._id;
                }
                if(hit.highlight) {
                    hit._source.highlight = hit.highlight;
                }
                return hit._source;
            });
            if (results.facets) {
                out.facets = results.facets;
            }
            if (results.aggregations) {                //not really elegant, but ES doesnt return the type...    
                out.aggregations = {};            
                _.each(results.aggregations, function(bucket, key) {
                    _.each(queryObj.aggs, function(queryObjbucket, queryObjkey) {
                        if(queryObjkey == key) {
                            _.each(_.keys(queryObjbucket), function(type) {
                                bucket._type = type;
                            });                            
                        }
                    });        
                    out.aggregations[key] = bucket;
                });
            }
            dfd.resolve(out);
        }).fail(function(errorObj) {
            var out = {
                title: 'Failed: ' + errorObj.status + ' code',
                message: errorObj.responseText
            };
            dfd.reject(out);
        });
        return dfd.promise();
    };
}(recline.Backend.ElasticSearch));