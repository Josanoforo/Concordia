# MaDI Companies: procedencia y licencia

Revisión del 22/oct/2026: repositorio oficial [MaDI-Bench](https://github.com/wbsg-uni-mannheim/MaDI-Bench/tree/062058d09c8abd97026e6d4e9908b433753f58d3), commit `062058d09c8abd97026e6d4e9908b433753f58d3`. El árbol completo no contiene LICENSE general; solo licencias de tres componentes de terceros. README raíz sin notas de licencia. No se atribuye la licencia de esos componentes al dataset/gold.

En [CITATION.cff](https://github.com/wbsg-uni-mannheim/MaDI-Bench/blob/062058d09c8abd97026e6d4e9908b433753f58d3/CITATION.cff) aparece literalmente: “If you use MaDI-Bench, please cite the following work.” No contiene campo `license`. Autores: Aaron Steiner, Ralph Peeters y Christian Bizer, University of Mannheim, 2026.

El [paper arXiv 2606.30371v2](https://arxiv.org/abs/2606.30371v2) enlaza literalmente [“Attribution-NonCommercial-NoDerivatives 4.0 International”](https://creativecommons.org/licenses/by-nc-nd/4.0/). Es la licencia del artículo, no una autorización general para redistribuir las tablas ni el gold del repositorio.

Los metadatos schema.org declaran literalmente: DBpedia `"license": "https://creativecommons.org/licenses/by-sa/3.0/"`; Forbes `"license": "https://creativecommons.org/licenses/by/4.0/"`; FullContact no contiene campo `license`. Los campos se registran en `evidence/madi-license.json`. Eso no resuelve la falta de licencia explícita del gold. Por la regla del encargo: **solo evaluación local; ninguna tabla ni gold se incorpora a Git**. Tampoco se aplica la licencia Apache del código de Concordia a esos archivos.

`npm run fetch-madi` descarga exactamente ocho archivos: tres CSV, sus tres metadatos, target_schema.json y sm_mapping_gold.json, exclusivamente bajo companies/base/input. Destino `.concordia/data/madi/`, ignorado por Git. No se clona el benchmark ni se instalan PyDI/PyTorch; no se descargan results, otros dominios ni gold de entity matching/fusión. Manifest local con hashes SHA256 y revisión fijada. Los ejemplos U3 versionados son sintéticos; las muestras reales y diferencias detalladas de evaluación quedan locales/ignoradas.

El predictor no lee sm_mapping_gold: usa los nombres/descripciones de columnas y target_schema. Solo el evaluador abre el gold. No se presupone equivalencia entre correspondencia semántica de columnas y FK/identidad de empresas.
