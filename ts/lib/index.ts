import * as fs from 'fs';
import * as express from 'express';
import { Router } from 'express';
import { json } from 'body-parser';


export { Http } from './Http';
import { Http } from './Http';

export { MVC } from './MVC';
import { MVC } from './MVC';

export { DB } from './DB';

export { ORM } from './ORM';


class Configuration
{

    private config:any = {};
    private envFileLoaded:boolean = false;

    public set(key:string, value:any):void
    {
        this.config[key.trim()] = typeof value === 'string' ? value.trim() : value;
    }

    public get(key:string, defaultValue:any=null):any
    {
        if (!this.envFileLoaded)
            this.loadEnvFile();

        if (typeof this.config[key] !== 'undefined')
            return this.config[key];

        return defaultValue;
    }

    private loadEnvFile()
    {
        let envFilePath = `${process.cwd()}/.env`;
        if (fs.existsSync(envFilePath)) {
            let envFileItem:Array<string> = fs.readFileSync(envFilePath, { 
                'encoding': 'utf8' 
            }).split('\n');

            envFileItem.forEach((row:string):void => {
                if (row.trim()[0] === '#')
                    return;

                let [key, value] = row.trim().split('=');
                if (key && value) {
                    this.set(key, value);
                    this.set(key.replace(/[\-\_]/g, '.').toLowerCase(), value);
                }
            });
        }

        this.envFileLoaded = true;
    }

}
export const Config:Configuration = new Configuration();

export class Cache
{

    public static get(fileName:string, defaultValue:any = null):string
    {
        if (!this.has(fileName))
            return defaultValue;

        let cacheContent:any = JSON.parse(this.decode(fs.readFileSync(
            `${process.cwd()}/storage/cache/${this.encode(fileName)}.cache`,
            { 'encoding': 'utf8' }
        )));

        let expiresAt:Date = new Date(cacheContent.expiresAt);
        if (expiresAt < new Date()) {
            this.delete(fileName);
            return defaultValue;
        }

        return cacheContent.data;
    }

    public static set(fileName:string, fileContent:string, expiresAt:Date = null):void
    {
        if (!expiresAt) {
            expiresAt = new Date();
            expiresAt.setHours(expiresAt.getHours() + 2);
        }

        let filePath:string = `${process.cwd()}/storage/cache/${this.encode(fileName)}.cache`;
        this.createPathIfNeeded(filePath);
        fs.writeFileSync(
            filePath,
            this.encode(JSON.stringify({
                'key': fileName,
                'data': fileContent,
                'expiresAt': expiresAt,
                'createdAt': new Date()
            }))
        );
    }

    public static has(fileName:string):boolean
    {
        return fs.existsSync(
            `${process.cwd()}/storage/cache/${this.encode(fileName)}.cache`
        );
    }

    public static delete(fileName:string):boolean
    {
        if (!this.has(fileName))
            return false;

        fs.unlinkSync(`${process.cwd()}/storage/cache/${this.encode(fileName)}.cache`);

        return true;
    }

    private static createPathIfNeeded(path):void
    {
        let folders:Array<string> = path.split('/');
        
        folders.reduce((builtPath:string, folder:string):string => {
            builtPath += `/${folder}`;
            if (builtPath !== '' && folder.substr(-6) !== '.cache') {
                if (!fs.existsSync(builtPath))
                    fs.mkdirSync(builtPath);
            }

            return builtPath;
        }); 
    }

    private static encode(str:string):string
    {
        return new Buffer(new Buffer(str)
            .toString('base64')
            .split('').reverse().join('')).toString('base64');
    }

    private static decode(str:string):string
    {
        return new Buffer(new Buffer(str, 'base64')
            .toString('utf8')
            .split('').reverse().join(''), 'base64').toString('utf8');
    }

}

export class App
{

    private app:express;

    public constructor(name:string='StackerJS')
    {
        this.app = express();
        Config.set('app.name', name);

        this.app.use(
            Config.get('static.url.prefix', '/static'),
            express.static(Config.get('static.folder', 'public'))
        );
        this.app.use(json({
            'limit': Config.get('upload.limit', '10mb')
        }));
    }

    public registerMicroService(microservice:MicroService, prefix:string='/'):void
    {
        this.app.use(prefix, microservice.getRoutes());   
    }

    public run(port:number=3000)
    {
        return this.app.listen(port, () => console.log(`App is running at port ${port}`));
    }

}

export class MicroService
{

    private name:string;
    private route:Router;

    public constructor(microServiceName:string='Micro StackerJS')
    {
        this.name = microServiceName;
        this.route = new Router();
    }

    public setMiddleware(middleware:MVC.IMiddleware):void
    {
        let answered:boolean = false;
        this.route.use((request, response, next):void => 
        {
            new Promise((resolve:Function, reject:Function):void => 
            {
                try {
                    resolve(middleware.do(new Http.Request(request)));
                } catch (err) {
                    reject(err);
                }
            })
                .then((callbackResponse:string|Http.Response) => {
                    if (typeof callbackResponse !== 'undefined')
                        answered = true;

                    return this.requestThen(callbackResponse, response)
                })
                .catch((err:Error) => {
                    answered = true;
                    return this.requestCatch(err, response)
                })
                .then(() => {
                    !answered ? next() : false
                });
        });
    }

    public setRoute(method:string, route:string, callbacks:Array<Function>|Function):void
    {
        if (!Array.isArray(callbacks))
            callbacks = [callbacks];

        let answered:boolean = false;
        this.route[method](
            route, 
            callbacks.map((callback:Function) => (request, response, next:Function) => 
            {
                new Promise((resolve:Function, reject:Function):void => {
                    try {
                        resolve(callback(new Http.Request(request)));
                    } catch (err) {
                        reject(err);
                    }
                })
                    .then((callbackResponse:string|Http.Response) => {
                        if (typeof callbackResponse !== 'undefined')
                            answered = true;

                        return this.requestThen(callbackResponse, response)
                    })
                    .catch((err:Error) => {
                        answered = true;
                        return this.requestCatch(err, response);
                    })
                    .then(() => !answered ? next() : false);
            })
        );
    }

    public registerController(controller:MVC.IController)
    {
        let routes:MVC.IControllerRoute = controller.routes();
        Object.keys(routes).map((httpMethod:string):void => {
            Object.keys(routes[httpMethod]).map((route:string):void => {
                let actions:Array<string>|string = routes[httpMethod][route];
                if (!Array.isArray(actions))
                    actions = [actions];

                this.setRoute(
                    httpMethod, 
                    route,
                    actions
                        .filter(action => controller[action] && typeof controller[action] === 'function')
                        .map(action => controller[action].bind(controller))
                );
            });
        });
    }

    public getRoutes():Router
    {
        return this.route;
    }

    private requestThen(callbackResponse:string|Http.Response, response:any):void
    {
        if (typeof callbackResponse === 'undefined')
            return;
            
        if (callbackResponse instanceof Http.Response) {
            response.set(callbackResponse.getHeaders());
            response.status(callbackResponse.getStatusCode());
            let responseContent = callbackResponse.getContent();
            return response[typeof responseContent === 'object' ? 'json' : 'send'](callbackResponse.getContent());
        }

        if (typeof callbackResponse === 'object') {
            return response.status(200).json(callbackResponse);
        }

        response.set('Content-type', 'text/html');
        response.status(200).send(callbackResponse);
    }

    private requestCatch(err:Error, response:any):void
    {
        if (err instanceof Http.Exception.HttpError) {
            if (typeof err.message === 'object')
                return response
                    .status(err.getCode())
                    .json(err.message);

            return response.status(err.getCode())
                .send(err.message);
        }

        response
            .status(500)
            .send(`Error 500. <br /><br />Message: ${err.message}.`);
    }

}